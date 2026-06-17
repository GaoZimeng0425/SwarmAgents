# Web 确认弹窗 + 权限滑出面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除所有 Electron 原生 `showMessageBox` 确认弹窗,改为 web 实现:权限申请(含高风险)统一为输入框上方的内联滑出面板,删除供应商确认改用已有的 web `AlertDialog`。

**Architecture:** 三步迁移 + 一步清理。① 改造 `permission-drawer.tsx`,从窗口底部 `fixed` dialog 变为 chat 列内贴着 composer 的内联滑出面板,并对高风险做视觉区分;② `use-events-subscription.ts` 去掉高风险走原生弹窗的分支,所有风险等级统一进 `usePermissionStore`;③ `providers-view.tsx` 删除确认改用 `AlertDialog`;④ 全部调用点迁走后,删除 `showConfirm` 的整条原生 IPC 链路。

**Tech Stack:** React + TypeScript、`@base-ui/react`(AlertDialog)、Zustand(`usePermissionStore`)、Vitest + `@testing-library/react`(jsdom)、Electron IPC、Biome。

**测试运行:** 全量 `npm test`;单文件 `npm test -- <path>`(底层是 `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`,**不要**用裸 `npx vitest`)。Typecheck:`npm run typecheck`。

---

### Task 1: 权限滑出面板改造 + 高风险视觉区分

把 `PermissionDrawer` 从 `fixed bottom-0` 模态卡片改为内联滑出面板,新增高风险 destructive 样式与 `data-risk` 标记,语义从 `role="dialog"` 改为 `role="region"`。

**Files:**
- Modify: `src/renderer/src/components/permission-drawer.tsx`
- Test: `src/renderer/src/components/permission-drawer.test.tsx`(新建)

- [ ] **Step 1: 写失败测试**

Create `src/renderer/src/components/permission-drawer.test.tsx`:

```tsx
// @vitest-environment jsdom

import type { PermissionPrompt } from '@/stores/permission'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionDrawer } from './permission-drawer'

const basePrompt: PermissionPrompt = {
  actionId: 'act-1',
  sessionId: 'sess-1',
  taskId: 'task-1',
  workerId: null,
  risk: 'medium',
  summary: 'Run shell command',
  payload: { cmd: 'ls' },
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PermissionDrawer', () => {
  it('renders nothing when prompt is null', () => {
    const { container } = render(<PermissionDrawer onDecide={() => {}} prompt={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders as a region (not a dialog) and exposes risk via data-risk', () => {
    render(<PermissionDrawer onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    const region = screen.getByRole('region', { name: /requires confirmation/i })
    expect(region).toHaveAttribute('data-risk', 'high')
  })

  it('Escape resolves the prompt as skip', () => {
    const onDecide = vi.fn()
    render(<PermissionDrawer onDecide={onDecide} prompt={basePrompt} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDecide).toHaveBeenCalledWith('act-1', 'skip')
  })

  it('high-risk autofocuses the Deny button', () => {
    render(<PermissionDrawer onDecide={() => {}} prompt={{ ...basePrompt, risk: 'high' }} />)
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/components/permission-drawer.test.tsx`
Expected: FAIL — 当前组件用 `role="dialog"`(无 `region`)、无 `data-risk` 属性、Deny 无 autofocus。

- [ ] **Step 3: 改写组件**

Replace the entire body of `src/renderer/src/components/permission-drawer.tsx` with:

```tsx
// src/renderer/src/components/permission-drawer.tsx
//
// 权限申请面板。渲染为 chat 列内、紧贴 composer 上方的内联滑出面板(非模态、
// 无 backdrop),进场上滑淡入。所有风险等级(medium/high)都经此面板决策;
// low 由主进程 permission gate 自动放行,不到渲染层。高风险仅做视觉区分
// (destructive 样式 + 默认焦点落在 Deny),不加二次确认门槛。Escape = skip。
import { useEffect, useRef } from 'react'
import type { PermissionDecision } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PermissionPrompt } from '@/stores/permission'

type Props = {
  prompt: PermissionPrompt | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function PermissionDrawer({ prompt, onDecide }: Props): React.JSX.Element | null {
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!prompt) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDecide(prompt.actionId, 'skip')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [prompt, onDecide])

  // High-risk: park focus on Deny so the safe choice is the default.
  useEffect(() => {
    if (prompt?.risk === 'high') denyRef.current?.focus()
  }, [prompt])

  if (!prompt) return null

  const isHigh = prompt.risk === 'high'

  return (
    <div
      aria-label="Action requires confirmation"
      className={cn(
        'mx-3 mb-2 max-h-[50vh] shrink-0 overflow-auto rounded-xl border bg-popover/95 px-4 py-3 shadow-lg',
        'duration-200 animate-in fade-in-0 slide-in-from-bottom-3',
        isHigh ? 'border-destructive/50 ring-1 ring-destructive/30' : 'border-border'
      )}
      data-risk={prompt.risk}
      role="region"
    >
      <div className="flex flex-col gap-3">
        <header>
          <h2 className={cn('font-medium text-base', isHigh && 'text-destructive')}>
            Action requires confirmation
          </h2>
          <p className="text-muted-foreground text-sm">
            Task {prompt.taskId} · risk: <strong>{prompt.risk}</strong>
          </p>
        </header>
        <div className="text-sm">{prompt.summary}</div>
        <pre className="max-h-40 overflow-auto rounded bg-muted p-3 font-mono text-xs">
          {JSON.stringify(prompt.payload, null, 2)}
        </pre>
        <footer className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onDecide(prompt.actionId, 'skip')
            }}
            variant="secondary"
          >
            Skip
          </Button>
          <Button
            onClick={() => {
              onDecide(prompt.actionId, 'grant')
            }}
          >
            Allow
          </Button>
          <Button
            onClick={() => {
              onDecide(prompt.actionId, 'deny')
            }}
            ref={denyRef}
            variant="destructive"
          >
            Deny
          </Button>
        </footer>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/renderer/src/components/permission-drawer.test.tsx`
Expected: PASS(4 个用例全绿)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/permission-drawer.tsx src/renderer/src/components/permission-drawer.test.tsx
git commit -m "feat(permission): inline slide-out panel + high-risk styling"
```

---

### Task 2: 高风险权限并入面板队列(移除原生分支)

`use-events-subscription.ts` 删除 `handleHighRisk`,`task.permission_request` 不再按 risk 分流,统一 `push` 进 `usePermissionStore`。

**Files:**
- Modify: `src/renderer/src/hooks/use-events-subscription.ts`
- Test: `src/renderer/src/hooks/use-tasks.test.tsx`(追加用例)

- [ ] **Step 1: 写失败测试**

在 `src/renderer/src/hooks/use-tasks.test.tsx` 顶部 import 区追加(若尚未导入):

```tsx
import { usePermissionStore } from '../stores/permission'
```

在 `beforeEach` 中追加一行重置权限 store(与现有 sessions 重置并列):

```tsx
  usePermissionStore.setState({ queue: [] })
```

在最外层 `describe('use-tasks + use-events-subscription', …)` 内追加用例:

```tsx
  it('a high-risk permission_request goes into the permission store (no native dialog)', async () => {
    let emit: (e: UIEvent) => void = () => {}
    vi.spyOn(api.swarmApi, 'subscribeEvents').mockImplementation((cb) => {
      emit = cb
      return () => {}
    })

    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } } })
    renderHook(() => useEventsSubscription(), { wrapper: makeWrapper(qc) })

    act(() => {
      emit({
        kind: 'task.permission_request',
        ts: 1,
        sessionId: 'sess-1',
        taskId: 'task-1',
        workerId: null,
        actionId: 'act-9',
        risk: 'high',
        toolName: 'shell',
        summary: 'rm -rf /tmp/x',
        payload: { cmd: 'rm -rf /tmp/x' },
      } as UIEvent)
    })

    await waitFor(() => {
      expect(usePermissionStore.getState().queue.some((p) => p.actionId === 'act-9')).toBe(true)
    })
  })
```

> 注:`task.permission_request` 事件字段以 `src/shared/types/ui.ts` 中 `UIEvent` 的实际定义为准;若某字段名不符,按该类型调整 emit 的对象(用 `as UIEvent` 兜底编译)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/hooks/use-tasks.test.tsx`
Expected: FAIL — 当前高风险走 `handleHighRisk`,调用 `window.swarm.showConfirm`(jsdom 下 `window.swarm` 为 undefined → 抛错),不会进 store。

- [ ] **Step 3: 改实现**

In `src/renderer/src/hooks/use-events-subscription.ts`:

(a) 删除整个 `handleHighRisk` 函数(原 25–39 行)。

(b) 把 `task.permission_request` 分支:

```tsx
      if (e.kind === 'task.permission_request') {
        if (e.risk === 'high') {
          // Native dialog; do NOT push into the drawer queue.
          void handleHighRisk(e)
        } else {
          push(buildPrompt(e))
        }
      }
```

替换为:

```tsx
      if (e.kind === 'task.permission_request') {
        // All risk levels (medium + high) surface in the inline permission panel.
        push(buildPrompt(e))
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/renderer/src/hooks/use-tasks.test.tsx`
Expected: PASS(含新用例)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/hooks/use-events-subscription.ts src/renderer/src/hooks/use-tasks.test.tsx
git commit -m "feat(permission): route high-risk requests into the inline panel"
```

---

### Task 3: 删除供应商确认改用 AlertDialog

`providers-view.tsx` 的 `DeleteButton` 把命令式 `window.swarm.showConfirm` 换成声明式 `AlertDialog`(受控 open)。

**Files:**
- Modify: `src/renderer/src/components/views/providers-view.tsx`(import 区 + `DeleteButton`,当前在 :381–401)

- [ ] **Step 1: 加 import**

确认 `providers-view.tsx` 顶部已有 `useState` 导入(若没有则加入 `import { useState } from 'react'` 或并入现有 react import)。在 ui 组件 import 区追加:

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
```

- [ ] **Step 2: 改写 `DeleteButton`**

把当前(:381–401)整个 `DeleteButton` 替换为:

```tsx
function DeleteButton({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const confirmDelete = async (): Promise<void> => {
    const r = await window.swarm.providers.removeCustomProvider(id)
    if (r.ok) {
      onDeleted()
      setOpen(false)
    }
  }
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger render={<Button size="sm" variant="outline" />}>删除</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除供应商 {name}?</AlertDialogTitle>
          <AlertDialogDescription>这会移除该供应商及其 API Key。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirmDelete()} variant="destructive">
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

> `AlertDialogAction` 的底层是 `Button`(见 `alert-dialog.tsx:144`),`variant="destructive"` 直接透传。`AlertDialogTrigger` 用 base-ui 的 `render` prop 把触发器渲染成现有的 `Button` 外观。点"删除"后 `confirmDelete` 成功才关闭;失败保持打开(沿用旧行为,不新增 toast)。

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS(无类型错误)。

- [ ] **Step 4: 手动验证(可选但推荐)**

用 run-desktop / run skill 启动应用 → 设置 → Providers → 对一个自定义供应商点"删除" → 出现居中 AlertDialog → "取消"关闭、"删除"执行删除。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/views/providers-view.tsx
git commit -m "feat(providers): replace native delete confirm with AlertDialog"
```

---

### Task 4: 移除原生确认 IPC 链路

两个调用点都已迁走,删除 `showConfirm` 的全部 native 实现与类型。

**Files:**
- Delete: `src/main/system/confirm.ts`
- Delete: `src/main/system/confirm.test.ts`
- Delete: `src/renderer/src/hooks/use-native-confirm.ts`
- Modify: `src/main/ipc/swarm-ipc.ts`(:5 import、:12 import、:166–172 handler+注册、:232 removeHandler)
- Modify: `src/preload/index.ts`(:165)
- Modify: `src/shared/types/ui.ts`(:10 import、:208 方法)
- Modify: `src/shared/types/ipc.ts`(:89–108 Confirm schema/type)
- Modify: `src/shared/types/ipc.test.ts`(:79–104 两个 describe + import)

- [ ] **Step 1: 先用 codegraph 复核引用,确认无遗漏**

Run: `rg -n "showConfirm|ConfirmRequest|ConfirmResponse|showNativeConfirm|useNativeConfirm"  src`
Expected: 命中仅限上表列出的文件。若出现其他调用方,先把它迁移掉再继续(不应有——Task 2/3 已清掉两个调用点)。

- [ ] **Step 2: 删除三个文件**

```bash
git rm src/main/system/confirm.ts src/main/system/confirm.test.ts src/renderer/src/hooks/use-native-confirm.ts
```

- [ ] **Step 3: 清理 `src/main/ipc/swarm-ipc.ts`**

- 删除第 5 行 import 里的 `ConfirmRequest`/`ConfirmRequestSchema`/`ConfirmResponse`(若该 import 行只剩这些则整行删除;否则只删这三个名字)。
- 删除第 12 行 `import { showNativeConfirm } from '../system/confirm'`。
- 删除 `handleShowConfirm` 函数(:166–171 一带)及其注册 `ipcMain.handle('system:showConfirm', handleShowConfirm)`(:172)。
- 删除清理逻辑里的 `ipcMain.removeHandler('system:showConfirm')`(:232)。

- [ ] **Step 4: 清理 `src/preload/index.ts`**

删除第 165 行:

```tsx
  showConfirm: (req) => ipcRenderer.invoke('system:showConfirm', req) as Promise<'grant' | 'deny' | 'skip'>,
```

- [ ] **Step 5: 清理 `src/shared/types/ui.ts`**

- 第 10 行 import:从 `import type { ConfirmRequest, ConfirmResponse, Risk } from './ipc'` 删掉 `ConfirmRequest, ConfirmResponse,`,保留 `Risk`。
- 删除第 208 行 `showConfirm(req: ConfirmRequest): Promise<ConfirmResponse>`。

- [ ] **Step 6: 清理 `src/shared/types/ipc.ts`**

删除 :89–108 的:`ConfirmRequestSchema`、`ConfirmRequest`、`ConfirmResponseSchema`、`ConfirmResponse` 四个声明。

- [ ] **Step 7: 清理 `src/shared/types/ipc.test.ts`**

- 删除 import 里的 `ConfirmRequestSchema`、`ConfirmResponseSchema`。
- 删除 `describe('ConfirmRequestSchema', …)`(:79 起)与 `describe('ConfirmResponseSchema', …)`(:101 起)两个块。

- [ ] **Step 8: Typecheck + 全量测试**

Run: `npm run typecheck && npm test`
Expected: PASS。`showConfirm` 是 `SwarmBridge` 公开 API,任何遗漏调用方都会在此 typecheck 报错——绿表示删干净。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: remove native showConfirm IPC plumbing"
```

---

### Task 5: 终检

- [ ] **Step 1: Biome**

Run: `npx biome check --write src/renderer/src/components/permission-drawer.tsx src/renderer/src/components/permission-drawer.test.tsx src/renderer/src/hooks/use-events-subscription.ts src/renderer/src/components/views/providers-view.tsx src/main/ipc/swarm-ipc.ts src/preload/index.ts src/shared/types/ui.ts src/shared/types/ipc.ts src/shared/types/ipc.test.ts src/renderer/src/hooks/use-tasks.test.tsx`
Expected: 无 lint 错误(注意:不要用 `pnpm check`/裸 `biome check .`,会重格式化全仓)。

- [ ] **Step 2: 全量 typecheck + test**

Run: `npm run typecheck && npm test`
Expected: 全绿。

- [ ] **Step 3: 手动冒烟(run-desktop / run skill)**

- 触发一次高风险 agent 动作 → 确认是输入框上方滑出面板(destructive 样式、焦点在 Deny),不是系统弹窗。
- 触发一次中风险动作 → 同一面板正常。
- 设置 → Providers → 删除自定义供应商 → AlertDialog 居中确认。

- [ ] **Step 4: 若有未提交改动则 Commit**

```bash
git add -A
git commit -m "chore: lint + final sweep for web confirm migration"
```

---

## Self-Review

**Spec coverage:**
- 目标①(删原生弹窗)→ Task 4。
- 目标②(权限统一滑出,含高风险)→ Task 1 + Task 2。
- 目标③(删除确认用 AlertDialog)→ Task 3。
- 目标④(清理 IPC 链路)→ Task 4。
- spec 测试要求(permission-drawer 高风险样式 + Escape→skip;删 confirm/ipc 测试)→ Task 1 测试 + Task 4 Step 7/Step 2。
- 全部 spec 站点表(单元 4 的 8 个文件)→ Task 4 Step 2–7 逐一覆盖。

**Placeholder scan:** 无 TBD/TODO;所有代码步骤含完整代码;唯一柔性处是 Task 2 的 `UIEvent` 字段以实际类型为准,已给出 `as UIEvent` 兜底与调整说明。

**Type consistency:** `PermissionPrompt`、`PermissionDecision`、`usePermissionStore`、`AlertDialog*` 全部沿用现有定义;`removeCustomProvider` 返回 `{ ok }` 与现有 `providers-view` 用法一致;`Button` 的 `ref`/`variant`/`size` 与现有组件签名一致。
