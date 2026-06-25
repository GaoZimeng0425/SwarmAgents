# 连发消息：排队 + 取消 + 打断插队 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一 session 连发多条消息成为一等体验——默认排队、可视化队列、逐项取消、逐项打断插队（取消当前并保留部分结果后立即跑被提项）。

**Architecture:** 后端把 `Session` 的 promise-chain 队列（`queue: Promise<void>`）换成显式数组 `pending[]` + `running` + `pump()`，以支持重排序（插队）；`cancelTask` 扩展为既能 abort 运行中任务、也能从队列移除排队项；新增 `interruptWith` 把某排队项提到队首并 abort 当前任务。IPC 三层镜像现有 `cancelTask` 通道暴露 `interruptWith`。渲染层把发送键恢复为「始终发送」，停止键与排队卡片移入 composer 上方的 `ComposerOverlay`。

**Tech Stack:** TypeScript、Electron（main / preload / renderer / utilityProcess service）、React、@tanstack/react-query、vitest（`npm test`，经 Electron 跑）、@testing-library/react + jsdom（组件测试）、pino（结构化日志）。

## Global Constraints

- 代码注释与 commit message 一律英文；对话用中文（CLAUDE.md §0）。
- 每条业务路径打结构化日志：入口/出口 `info`、每个 `catch` `error`、分支意外 `warn`（CLAUDE.md §5）。结构化首参：`log.info({ msg: '...', sessionId, taskId })`，禁字符串插值。
- 跑测试用 `npm test`（经 Electron node），**禁止** `pnpm rebuild better-sqlite3`。
- 改动外科手术式：每行可追溯到本需求；不顺手重构无关代码（CLAUDE.md §3）。
- 队列顺序不持久化（ephemeral，存于 service 进程内存）；不支持编辑排队消息内容（YAGNI）。
- 一次只跑一条 per session；全局并发上限仍由 `acquireSlot`（`maxConcurrent`）控制，本计划不改其语义。
- 排队任务 = `status: 'pending'`；运行中 = `status ∈ {running, awaiting_user}`；取消通过 `task.error` 且 `error.code === 'cancelled'` 让渲染层 reducer 置为 `cancelled`（见 `src/renderer/src/lib/apply-event.ts:34,86`）。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/service/session/manager.ts` | 队列与执行编排 | `Session` 结构、`pump()`、`submitGoal`、`cancelTask`、新增 `interruptWith` |
| `src/service/session/manager.test.ts` | 后端队列行为测试 | 新增 3 个用例 |
| `src/shared/types/service-ipc.ts` | service 方法名联合类型 | 加 `'interruptWith'` |
| `src/shared/types/ui.ts` | `window.swarm` 接口类型 | 加 `interruptWith` |
| `src/service/ipc/dispatcher.ts` | service 进程方法分发 | 加 `case 'interruptWith'` |
| `src/main/service-client.ts` | main→service RPC 客户端 | 加 `interruptWith` 类型 + 实现 |
| `src/main/ipc/swarm-ipc.ts` | renderer→main IPC 处理 | 加 handler + register + removeHandler |
| `src/preload/index.ts` | preload bridge | 加 `interruptWith` |
| `src/renderer/src/lib/api.ts` | renderer API 封装 | 加 `interruptWith` |
| `src/renderer/src/hooks/use-tasks.ts` | react-query mutation hooks | 加 `useInterruptWith` |
| `src/renderer/src/components/chat-input.tsx` | composer 输入框 | 发送键恢复始终发送，移除停止职责 |
| `src/renderer/src/components/composer-overlay.tsx` | composer 上方固定堆叠区 | 新增运行/停止条 + 排队卡片 |
| `src/renderer/src/components/composer-overlay.test.tsx` | overlay 组件测试 | 新增排队/停止用例 |
| `src/renderer/src/components/views/tasks-view.tsx` | 主聊天视图接线 | 区分 running/queued + 接 cancel/interrupt/stop |

---

## Task 1: 后端——显式队列 + pump（替换 promise 链）

把 promise-chain 队列换成可重排序的显式数组。本任务**不改变可观察行为**（仍 FIFO 串行），目标是为后续插队提供结构；验证标准是现有 `manager.test.ts` 全绿（尤其「serializes per session」用例）。

**Files:**
- Modify: `src/service/session/manager.ts`（`Session` 类型 ~60-66；3 处创建点 `queue: Promise.resolve()` ~566/612/646；`submitGoal` 尾部 ~766）
- Test: `src/service/session/manager.test.ts`（沿用既有用例验证）

**Interfaces:**
- Produces: `type QueuedTurn = { taskId: string; runTurn: () => Promise<void> }`；`Session` 字段 `pending: QueuedTurn[]`、`running: string | null`；内部函数 `pump(session: Session): void`。
- Consumes: 现有 `runTurn`（submitGoal 内部闭包，签名不变，自带 `acquireSlot`/`releaseSlot` 与 try/finally）。

- [ ] **Step 1: 先跑现有测试确认基线全绿**

Run: `npm test -- src/service/session/manager.test.ts`
Expected: PASS（全部用例，含 `seeds each turn from the previous turn messages (continuity) and serializes per session`）

- [ ] **Step 2: 改 `Session` 类型**

把 `src/service/session/manager.ts` 的 `Session` 定义（当前含 `queue: Promise<void>`）改为：

```ts
type QueuedTurn = { taskId: string; runTurn: () => Promise<void> }

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  // FIFO queue of turns not yet started; the running turn is NOT in here.
  pending: QueuedTurn[]
  // taskId of the turn currently executing, or null when idle.
  running: string | null
}
```

- [ ] **Step 3: 改 3 处 Session 创建点**

把三处 `queue: Promise.resolve(),`（`getOrRehydrate`、`createSession`、`ensureSystemSession` 内）各替换为：

```ts
      pending: [],
      running: null,
```

- [ ] **Step 4: 新增 `pump` 函数**

在 `createSessionManager` 内、`acquireSlot`/`releaseSlot` 定义之后加入：

```ts
  // Run the next queued turn for a session, one at a time. A turn's finally
  // clears `running` and re-pumps, so the queue drains in order; cancelling or
  // completing the running turn naturally advances to the next.
  const pump = (session: Session): void => {
    if (session.running) return
    const next = session.pending.shift()
    if (!next) return
    session.running = next.taskId
    log.info({ msg: 'turn started', sessionId: session.id, taskId: next.taskId, queueDepth: session.pending.length })
    void next.runTurn().finally(() => {
      session.running = null
      pump(session)
    })
  }
```

- [ ] **Step 5: 改 `submitGoal` 入队**

把 `submitGoal` 尾部的：

```ts
      session.queue = session.queue.then(runTurn, runTurn)
      return { taskId }
```

替换为：

```ts
      session.pending.push({ taskId, runTurn })
      pump(session)
      return { taskId }
```

（`runTurn` 闭包本身不动；它仍在内部 `acquireSlot()` 占全局槽位、`finally` 里 `releaseSlot()`。）

- [ ] **Step 6: 跑测试确认行为未变**

Run: `npm test -- src/service/session/manager.test.ts`
Expected: PASS（全绿；`serializes per session` 用例证明：submit 两条后只有第一条 run，resolveFirst 后第二条才以第一条保存的 messages 为种子运行）

- [ ] **Step 7: Commit**

```bash
git add src/service/session/manager.ts
git commit -m "refactor(session): explicit pending queue + pump, replacing promise-chain"
```

---

## Task 2: 后端——`cancelTask` 支持取消排队项

让 `cancelTask` 既能 abort 运行中任务（现状），也能把尚未开始的排队项从队列移除并标记 cancelled。

**Files:**
- Modify: `src/service/session/manager.ts`（`cancelTask` ~784）
- Test: `src/service/session/manager.test.ts`

**Interfaces:**
- Consumes: `sessions` map、`oneShotHandles`、`makeEmit(sessionId)`、`store.updateTaskStatus`、`Session.pending`。
- Produces: `cancelTask(sessionId, taskId)` 行为扩展（签名不变）。

- [ ] **Step 1: 写失败测试**

在 `src/service/session/manager.test.ts` 的 `describe('SessionManager', ...)` 内新增：

```ts
  it('cancelTask drops a queued task so it never runs and marks it cancelled', async () => {
    const ran: string[] = []
    let resolveA: (() => void) | null = null
    mockCreate.mockImplementation((deps: { task: { goal: string }; saveSnapshot?: (m: unknown, u: unknown) => void }) => ({
      run: async () => {
        ran.push(deps.task.goal)
        if (deps.task.goal === 'A') {
          await new Promise<void>((r) => {
            resolveA = r
          })
        }
        deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })
        return { status: 'completed' as const, summary: '' }
      },
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'A')
    const { taskId: bId } = manager.submitGoal(sessionId, 'B')
    await new Promise((r) => setTimeout(r, 0))

    manager.cancelTask(sessionId, bId)
    expect(store.getSessionTasks(sessionId).find((t) => t.id === bId)?.status).toBe('cancelled')

    resolveA!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['A']) // B was cancelled before it could run
    store.close()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/service/session/manager.test.ts -t "drops a queued task"`
Expected: FAIL（当前 `cancelTask` 对排队项无效，B 仍会运行 → `ran` 为 `['A','B']`，且 B 状态非 `cancelled`）

- [ ] **Step 3: 实现**

把 `cancelTask` 方法体替换为：

```ts
    cancelTask(sessionId, taskId) {
      log.info({ msg: 'task cancel requested', sessionId, taskId })
      // Running (or about-to-run with a registered abort handle): abort the run.
      const handle = oneShotHandles.get(taskId)
      if (handle) {
        handle.abort()
        return
      }
      // Queued but not yet started: remove from the queue and mark cancelled.
      const session = sessions.get(sessionId)
      const idx = session ? session.pending.findIndex((q) => q.taskId === taskId) : -1
      if (session && idx !== -1) {
        session.pending.splice(idx, 1)
        store.updateTaskStatus(taskId, 'cancelled')
        // Surface to the UI so the queued card is dropped; reducer maps a
        // task.error with code 'cancelled' to the cancelled status.
        makeEmit(sessionId)('task.error', {
          taskId,
          error: { code: 'cancelled', message: 'Cancelled before start', tier: 'fatal' },
          ts: Date.now(),
        })
        log.info({ msg: 'queued task cancelled', sessionId, taskId })
        return
      }
      log.warn({ msg: 'cancelTask: unknown or already-finished task', sessionId, taskId })
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/service/session/manager.test.ts -t "drops a queued task"`
Expected: PASS

- [ ] **Step 5: 跑全文件确认无回归**

Run: `npm test -- src/service/session/manager.test.ts`
Expected: PASS（含既有 `cancelTask aborts the running task signal`）

- [ ] **Step 6: Commit**

```bash
git add src/service/session/manager.ts src/service/session/manager.test.ts
git commit -m "feat(session): cancelTask drops queued tasks before they run"
```

---

## Task 3: 后端——`interruptWith`（提到队首 + 取消当前）

新增 `interruptWith`：把某排队项移到队首；若有运行中任务则 abort 它（保留其部分结果），其 `finally` 触发 `pump` 跑被提项；若无运行中任务则直接 `pump`。

**Files:**
- Modify: `src/service/session/manager.ts`（`SessionManager` 类型 ~100 区域；方法实现 ~785 区域）
- Test: `src/service/session/manager.test.ts`

**Interfaces:**
- Consumes: `sessions`、`oneShotHandles`、`Session.pending`、`Session.running`、`pump`。
- Produces: `SessionManager.interruptWith(sessionId: string, taskId: string): void`。

- [ ] **Step 1: 写失败测试**

在 `manager.test.ts` 内新增：

```ts
  it('interruptWith cancels the running task and runs the promoted one before the rest', async () => {
    const ran: string[] = []
    mockCreate.mockImplementation((deps: { task: { goal: string }; signal?: AbortSignal; saveSnapshot?: (m: unknown, u: unknown) => void }) => ({
      run: () =>
        new Promise<{ status: 'completed' | 'cancelled'; summary: string }>((resolve) => {
          ran.push(deps.task.goal)
          if (deps.task.goal === 'A') {
            // A stays running until interrupted (aborted).
            deps.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', summary: '' }))
            return
          }
          deps.saveSnapshot?.([], { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 })
          resolve({ status: 'completed', summary: '' })
        }),
    }))

    const store = createConversationStore(dbPath)
    const broadcaster = createBroadcaster()
    const manager = createSessionManager({ store, broadcaster, maxConcurrent: 4, getProvider: () => undefined })
    const { sessionId } = manager.createSession(providerA)

    manager.submitGoal(sessionId, 'A') // runs
    manager.submitGoal(sessionId, 'B') // queued
    const { taskId: cId } = manager.submitGoal(sessionId, 'C') // queued
    await new Promise((r) => setTimeout(r, 0))

    manager.interruptWith(sessionId, cId) // cancel A, jump C ahead of B
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['A', 'C', 'B'])
    store.close()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/service/session/manager.test.ts -t "interruptWith cancels"`
Expected: FAIL（`manager.interruptWith` 未定义 → TypeError）

- [ ] **Step 3: 在 `SessionManager` 类型加方法签名**

在 `src/service/session/manager.ts` 的 `export type SessionManager = { ... }` 中、`cancelTask` 声明附近加入：

```ts
  /**
   * Promote a queued task to the front of its session queue and interrupt the
   * running task (if any), so the promoted task runs next. The interrupted task
   * is cancelled with its partial output preserved in the session history.
   */
  interruptWith(sessionId: string, taskId: string): void
```

- [ ] **Step 4: 实现方法**

在返回对象里、`cancelTask` 方法之后加入：

```ts
    interruptWith(sessionId, taskId) {
      const session = sessions.get(sessionId)
      if (!session) {
        log.warn({ msg: 'interruptWith: unknown session', sessionId, taskId })
        return
      }
      const idx = session.pending.findIndex((q) => q.taskId === taskId)
      if (idx === -1) {
        log.warn({ msg: 'interruptWith: task not in queue', sessionId, taskId })
        return
      }
      // Jump the queue: move the chosen turn to the front.
      const [item] = session.pending.splice(idx, 1)
      session.pending.unshift(item)
      const cancelledTaskId = session.running
      log.info({ msg: 'task interrupted, promoted to front', sessionId, taskId, cancelledTaskId })
      if (cancelledTaskId) {
        // Abort the running task; its run returns 'cancelled' with partial
        // output already saved via saveSnapshot, and its finally re-pumps,
        // which now picks the promoted item.
        oneShotHandles.get(cancelledTaskId)?.abort()
      } else {
        // Idle session — run the promoted item immediately.
        pump(session)
      }
    },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- src/service/session/manager.test.ts -t "interruptWith cancels"`
Expected: PASS

- [ ] **Step 6: 跑全文件 + typecheck**

Run: `npm test -- src/service/session/manager.test.ts && npm run typecheck:node`
Expected: PASS（测试全绿；node 侧类型检查通过）

- [ ] **Step 7: Commit**

```bash
git add src/service/session/manager.ts src/service/session/manager.test.ts
git commit -m "feat(session): interruptWith promotes a queued task and cancels the running one"
```

---

## Task 4: IPC——把 `interruptWith` 贯通各层

镜像现有 `cancelTask` 的链路，把 `interruptWith` 从 renderer 一路接到 service manager。

**Files:**
- Modify: `src/shared/types/service-ipc.ts`、`src/shared/types/ui.ts`、`src/service/ipc/dispatcher.ts`、`src/main/service-client.ts`、`src/main/ipc/swarm-ipc.ts`、`src/preload/index.ts`、`src/renderer/src/lib/api.ts`、`src/renderer/src/hooks/use-tasks.ts`

**Interfaces:**
- Consumes: `manager.interruptWith`（Task 3）。
- Produces: `window.swarm.interruptWith(sessionId, taskId): Promise<void>`；`swarmApi.interruptWith`；`useInterruptWith()`（react-query mutation，入参 `{ sessionId, taskId }`）。

- [ ] **Step 1: service 方法名联合类型**

`src/shared/types/service-ipc.ts`：在含 `| 'cancelTask'` 的方法名联合里加一行：

```ts
  | 'interruptWith'
```

- [ ] **Step 2: dispatcher 分发**

`src/service/ipc/dispatcher.ts`：在 `case 'cancelTask'` 之后加入：

```ts
      case 'interruptWith': {
        const [sessionId, taskId] = args as [string, string]
        manager.interruptWith(sessionId, taskId)
        return { ok: true }
      }
```

- [ ] **Step 3: service-client 类型 + 实现**

`src/main/service-client.ts`：在 `cancelTask` 类型声明附近加：

```ts
  interruptWith(sessionId: string, taskId: string): Promise<void>
```

在实现对象里、`cancelTask` 实现之后加：

```ts
    async interruptWith(sessionId, taskId) {
      await call('interruptWith', [sessionId, taskId])
    },
```

- [ ] **Step 4: main IPC handler**

`src/main/ipc/swarm-ipc.ts`：在 `cancelTask` handler 之后加：

```ts
  const interruptWith = async (_e: Electron.IpcMainInvokeEvent, sessionId: string, taskId: string): Promise<void> => {
    try {
      await serviceClient.interruptWith(sessionId, taskId)
      log.info({ msg: 'interruptWith requested', sessionId, taskId })
    } catch (err) {
      log.warn({ msg: 'interruptWith failed', sessionId, taskId, err: String(err) })
    }
  }
```

在 `ipcMain.handle('swarm:cancelTask', cancelTask)` 之后加：

```ts
  ipcMain.handle('swarm:interruptWith', interruptWith)
```

在 `ipcMain.removeHandler('swarm:cancelTask')` 之后加：

```ts
      ipcMain.removeHandler('swarm:interruptWith')
```

- [ ] **Step 5: preload bridge**

`src/preload/index.ts`：在 `cancelTask:` 行之后加：

```ts
  interruptWith: (sessionId, taskId) => ipcRenderer.invoke('swarm:interruptWith', sessionId, taskId) as Promise<void>,
```

- [ ] **Step 6: window.swarm 接口类型**

`src/shared/types/ui.ts`：在 `cancelTask(sessionId: string, taskId: string): Promise<void>` 之后加：

```ts
  interruptWith(sessionId: string, taskId: string): Promise<void>
```

- [ ] **Step 7: renderer api 封装**

`src/renderer/src/lib/api.ts`：在 `cancelTask:` 行之后加：

```ts
  interruptWith: (sessionId: string, taskId: string): Promise<void> => window.swarm.interruptWith(sessionId, taskId),
```

- [ ] **Step 8: react-query mutation hook**

`src/renderer/src/hooks/use-tasks.ts`：在 `useCancelTask` 之后加：

```ts
/** Interrupt the running task and run a queued task next (promotes it to front). */
export function useInterruptWith() {
  return useMutation({
    mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) =>
      swarmApi.interruptWith(sessionId, taskId),
  })
}
```

- [ ] **Step 9: typecheck 全量**

Run: `npm run typecheck`
Expected: PASS（node + web 两侧类型检查通过，证明八层签名一致）

- [ ] **Step 10: Commit**

```bash
git add src/shared/types/service-ipc.ts src/shared/types/ui.ts src/service/ipc/dispatcher.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/renderer/src/lib/api.ts src/renderer/src/hooks/use-tasks.ts
git commit -m "feat(ipc): thread interruptWith from renderer to session manager"
```

---

## Task 5: 渲染层——发送键恢复「始终发送」

去掉「运行中把发送键变停止键」的逻辑：发送键永远是 submit（运行中可提交，进入排队）。停止职责移交 Task 6 的 `ComposerOverlay`。

**Files:**
- Modify: `src/renderer/src/components/chat-input.tsx`（Props 的 `status`/`onStop` ~39-40、264-265；`PromptInputSubmit` 用法 ~453）
- Test: `src/renderer/src/components/chat-input.test.tsx`

**Interfaces:**
- Produces: `ChatInput` 不再消费 `status`/`onStop`（从 Props 移除）；发送按钮始终 `type='submit'`。
- Consumes: 无新增。

- [ ] **Step 1: 写失败测试**

先看 `src/renderer/src/components/chat-input.test.tsx` 现有渲染辅助（如何 mock `window.swarm`/providers、如何 render `<ChatInput>`），沿用同样的 wrapper。新增用例：

```ts
  it('always exposes a submit affordance and never a stop one', async () => {
    const onSubmit = vi.fn()
    renderChatInput({ onSubmit }) // composer is status-agnostic after this task
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.submit(textarea.closest('form')!)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('hello', undefined))
    // The composer exposes a Submit affordance, never a Stop one.
    expect(screen.queryByLabelText('Stop')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Submit')).toBeInTheDocument()
  })
```

> 注：`renderChatInput` 用 `chat-input.test.tsx` 既有的渲染 helper；若该文件用的是内联 `render(<ChatInput .../>)`，照搬其 props 装配方式并补 `onSubmit`（不再需要 `status`/`onStop`）。`PromptInputSubmit` 的 aria-label 为 `'Submit'`/`'Stop'`（见 `prompt-input.tsx:1081`）。该用例先失败的原因：当前 `ChatInput` 在无 `status` 时默认渲染 Submit，但既有用例/实现仍保留 stop 分支——若现状下它已通过，则把断言强化为「移除 `status`/`onStop` prop 后仍成立」，真正的红→绿信号来自 Step 5 既有 stop 相关用例的更新。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/components/chat-input.test.tsx -t "submits even while a task is running"`
Expected: FAIL（当前 `status='streaming'` 会渲染 Stop 按钮、且 submit 走 onStop）

- [ ] **Step 3: 改 `PromptInputSubmit` 用法**

`src/renderer/src/components/chat-input.tsx`：把

```tsx
              <PromptInputSubmit disabled={disabled} onStop={onStop} status={status} />
```

改为

```tsx
              <PromptInputSubmit disabled={disabled} />
```

- [ ] **Step 4: 从 Props 与解构里移除 `status` / `onStop`**

在 `type Props` 中删除：

```tsx
  status?: ChatStatus
  onStop?: () => void
```

在组件参数解构中删除 `status,` 与 `onStop,` 两项。若 `ChatStatus` 的 import 因此变为未使用，一并删除该 import（CLAUDE.md §3：清理自己造成的 orphan）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- src/renderer/src/components/chat-input.test.tsx`
Expected: PASS（新用例通过；既有用例若断言过 Stop 行为，按本任务语义更新——发送键不再变停止键）

- [ ] **Step 6: 同步移除 tasks-view 对已删 props 的传参**

`src/renderer/src/components/views/tasks-view.tsx`：在 `<ChatInput .../>` 中删除这两行（Task 6 会把停止接到 overlay）：

```tsx
          onStop={() => {
            if (activeTask) cancelTask.mutate({ sessionId: activeTask.sessionId, taskId: activeTask.id })
          }}
```
```tsx
          status={activeTask ? (activeTask.status === 'pending' ? 'submitted' : 'streaming') : 'ready'}
```

Run: `npm run typecheck:web && npm test -- src/renderer/src/components/chat-input.test.tsx`
Expected: PASS（移除 props 后 web 侧类型一致；composer 测试全绿）

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/chat-input.tsx src/renderer/src/components/chat-input.test.tsx src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(composer): send button always submits, no stop affordance on the composer"
```

---

## Task 6: 渲染层——ComposerOverlay 运行/停止条 + 排队卡片 + tasks-view 接线

在 `ComposerOverlay` 加：①运行中的「执行中 + 停止」条（取代被移除的 composer 停止键）；②排队卡片列表，每张带「取消」「打断」。`tasks-view` 区分 running / queued 并接线三个动作。

**Files:**
- Modify: `src/renderer/src/components/composer-overlay.tsx`、`src/renderer/src/components/views/tasks-view.tsx`
- Test: `src/renderer/src/components/composer-overlay.test.tsx`

**Interfaces:**
- Consumes: `useCancelTask`、`useInterruptWith`（Task 4）；`TaskRecord`（`src/renderer/src/lib/apply-event.ts` 的 `status`/`goal`/`id`/`sessionId`）。
- Produces: `ComposerOverlay` 新增 props：
  - `running: boolean`（已有）+ `onStopRunning?: () => void`
  - `queued?: { id: string; sessionId: string; goal: string }[]`
  - `onCancelQueued?: (taskId: string) => void`
  - `onInterrupt?: (taskId: string) => void`

- [ ] **Step 1: 写失败测试**

在 `src/renderer/src/components/composer-overlay.test.tsx` 内新增：

```ts
  const queued = [
    { id: 'q1', sessionId: 'sess-1', goal: '修复登录 bug' },
    { id: 'q2', sessionId: 'sess-1', goal: '加个导航' },
  ]

  it('renders a stop control while running and fires onStopRunning', () => {
    const onStopRunning = vi.fn()
    render(
      <ComposerOverlay
        onDecide={() => {}}
        prompts={[]}
        running
        todos={[]}
        queued={[]}
        onStopRunning={onStopRunning}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /停止|stop/i }))
    expect(onStopRunning).toHaveBeenCalledTimes(1)
  })

  it('renders one queued card per pending task with cancel + interrupt', () => {
    const onCancelQueued = vi.fn()
    const onInterrupt = vi.fn()
    render(
      <ComposerOverlay
        onDecide={() => {}}
        prompts={[]}
        running
        todos={[]}
        queued={queued}
        onCancelQueued={onCancelQueued}
        onInterrupt={onInterrupt}
      />
    )
    expect(screen.getByText('修复登录 bug')).toBeInTheDocument()
    expect(screen.getByText('加个导航')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /取消排队|cancel/i })[0])
    expect(onCancelQueued).toHaveBeenCalledWith('q1')
    fireEvent.click(screen.getAllByRole('button', { name: /打断|interrupt/i })[1])
    expect(onInterrupt).toHaveBeenCalledWith('q2')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/renderer/src/components/composer-overlay.test.tsx -t "queued card"`
Expected: FAIL（overlay 尚不渲染排队卡片/停止键）

- [ ] **Step 3: 改 `ComposerOverlay`**

`src/renderer/src/components/composer-overlay.tsx` 全量替换为：

```tsx
import { useEffect } from 'react'
import type { PlanTodo } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'
import { SquareIcon, XIcon, ZapIcon } from 'lucide-react'

import { PermissionCard } from '@/components/permission-card'
import { PlanStatusBar } from '@/components/plan-status-bar'
import { Button } from '@/components/ui/button'
import type { PermissionPrompt } from '@/stores/permission'

type QueuedItem = { id: string; sessionId: string; goal: string }

type Props = {
  prompts: PermissionPrompt[]
  onDecide: (actionId: string, decision: PermissionDecision) => void
  todos: PlanTodo[]
  running: boolean
  onStopRunning?: () => void
  queued?: QueuedItem[]
  onCancelQueued?: (taskId: string) => void
  onInterrupt?: (taskId: string) => void
}

/**
 * Unified stack of pinned items above the composer. Top-to-bottom: the running
 * status/stop bar, the plan progress bar, queued-message cards (each cancellable
 * or interrupt-to-front), then any pending permission requests closest to the
 * input. Renders nothing when fully idle and empty. Width mirrors ChatInput
 * (px-4 outer + mx-auto max-w-3xl inner) so cards never exceed the input width.
 */
export function ComposerOverlay({
  prompts,
  onDecide,
  todos,
  running,
  onStopRunning,
  queued = [],
  onCancelQueued,
  onInterrupt,
}: Props): React.JSX.Element | null {
  const showPlan = running && todos.length > 0
  const top = prompts[0]

  // One Escape listener for the whole stack: skip the top-most prompt.
  useEffect(() => {
    if (!top) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDecide(top.actionId, 'skip')
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [top, onDecide])

  if (!running && prompts.length === 0 && queued.length === 0) return null

  return (
    <div className="shrink-0 px-4 pb-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {running && (
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="size-2 animate-pulse rounded-full bg-green-500" aria-hidden />
              执行中…
            </span>
            <Button aria-label="停止" onClick={onStopRunning} size="icon-sm" variant="ghost">
              <SquareIcon className="size-4" />
            </Button>
          </div>
        )}
        <PlanStatusBar running={running} todos={todos} />
        {queued.map((q) => (
          <div
            key={q.id}
            className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground" aria-hidden>
                ⏳
              </span>
              <span className="truncate">{q.goal}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button aria-label="打断" onClick={() => onInterrupt?.(q.id)} size="icon-sm" variant="ghost">
                <ZapIcon className="size-4" />
              </Button>
              <Button aria-label="取消排队" onClick={() => onCancelQueued?.(q.id)} size="icon-sm" variant="ghost">
                <XIcon className="size-4" />
              </Button>
            </span>
          </div>
        ))}
        {prompts.map((p, i) => (
          <PermissionCard autoFocusDeny={i === 0} key={p.actionId} onDecide={onDecide} prompt={p} />
        ))}
      </div>
    </div>
  )
}
```

> 若 `@/components/ui/button` 的 size 无 `'icon-sm'`，改用该组件实际提供的 icon size（参照 `prompt-input.tsx` 中 `InputGroupButton` 的 `size='icon-sm'` 用法确认可用值）。`lucide-react` 已是项目依赖（图标库），`SquareIcon`/`XIcon`/`ZapIcon` 均存在。

- [ ] **Step 4: 跑 overlay 测试确认通过**

Run: `npm test -- src/renderer/src/components/composer-overlay.test.tsx`
Expected: PASS（新用例 + 既有用例全绿；注意既有 `renders nothing when there are no prompts and no running plan` 用例：现签名默认 `queued=[]`、`running=false`，仍渲染 null ✓）

- [ ] **Step 5: tasks-view 接线**

`src/renderer/src/components/views/tasks-view.tsx`：

(a) 引入 hook：把 `import { useCancelTask, useDecidePermission, useSubmitGoal, useTasks } from '@/hooks/use-tasks'` 改为同时引入 `useInterruptWith`：

```tsx
import { useCancelTask, useDecidePermission, useInterruptWith, useSubmitGoal, useTasks } from '@/hooks/use-tasks'
```

(b) 取 mutation：在 `const cancelTask = useCancelTask()` 附近加：

```tsx
  const interruptWith = useInterruptWith()
```

(c) 区分 running / queued：把现有 `activeTask` 计算改为两个派生值（保留 `activeTask` 给其它用途，如 `runningTask`）：

```tsx
  const runningTask = sessionTasks.find((t) => t.status === 'running' || t.status === 'awaiting_user')
  const queuedTasks = sessionTasks.filter((t) => t.status === 'pending')
```

> `sessionTasks` 的排序：渲染顺序需为入队顺序（FIFO）。若 `sessionTasks` 非按 createdAt 升序，对 `queuedTasks` 追加 `.sort((a, b) => a.startedAt - b.startedAt)` 或按可用的创建时间字段升序（沿用文件内既有时间字段；`byRecent` 用的是 `startedAt` 降序，这里取升序）。

(d) `ComposerOverlay` 传参：把现有用法

```tsx
        <ComposerOverlay
          onDecide={(actionId, decision) => { ... }}
          prompts={sessionPrompts}
          running={!!activeTask}
          todos={activePlan ?? []}
        />
```

改为：

```tsx
        <ComposerOverlay
          onDecide={(actionId, decision) => {
            const p = sessionPrompts.find((x) => x.actionId === actionId)
            if (!p) return
            decide.mutate({ sessionId: p.sessionId, actionId, decision })
          }}
          prompts={sessionPrompts}
          running={!!runningTask}
          todos={activePlan ?? []}
          onStopRunning={() => {
            if (runningTask) cancelTask.mutate({ sessionId: runningTask.sessionId, taskId: runningTask.id })
          }}
          queued={queuedTasks.map((t) => ({ id: t.id, sessionId: t.sessionId, goal: t.goal }))}
          onCancelQueued={(taskId) => {
            if (selectedSessionId) cancelTask.mutate({ sessionId: selectedSessionId, taskId })
          }}
          onInterrupt={(taskId) => {
            if (selectedSessionId) interruptWith.mutate({ sessionId: selectedSessionId, taskId })
          }}
        />
```

> 若文件内已有 `activeTask` 被别处引用（如某处判断），保留其定义；本任务只新增 `runningTask`/`queuedTasks` 并把 overlay 的 `running` 源切到 `runningTask`。检查 `activeTask` 其余引用，确保语义不变（运行中判断用 `runningTask`）。

- [ ] **Step 6: typecheck + 全量测试**

Run: `npm run typecheck:web && npm test -- src/renderer/src/components/composer-overlay.test.tsx src/renderer/src/components/chat-input.test.tsx`
Expected: PASS

- [ ] **Step 7: 手动验证（真实 app）**

启动 app（参照 `run-desktop` skill 或 `npm run dev`），在一个会话里：①发一条长任务；②运行中再发一条 → 该条出现在 composer 上方排队卡片，且发送键可用；③点排队卡片「取消」→ 卡片消失、不执行；④再发两条排队，点第二条「打断」→ 当前任务停止、被点的那条立即开始、另一条仍排队；⑤点运行中状态条「停止」→ 当前停止、队列下一条自动开始。
对照 `userData/swarm-dev.log`：应看到 `turn started`、`queued task cancelled`、`task interrupted, promoted to front` 日志行。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/composer-overlay.tsx src/renderer/src/components/composer-overlay.test.tsx src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(composer): queued-message cards with cancel + interrupt, running stop bar"
```

---

## Self-Review

**Spec coverage（逐条对照 spec）：**
- 默认排队、运行中可发 → Task 1（队列结构）+ Task 5（发送键始终发送）✓
- 展示队列 → Task 6（排队卡片）✓
- 取消排队项 → Task 2（后端）+ Task 6（UI 按钮接线）✓
- 打断插队（取消当前保留部分结果 + 提到队首立即跑）→ Task 3（`interruptWith`）+ Task 4（IPC）+ Task 6（UI）✓
- 普通停止后队列续跑 → Task 1（`pump` 在 `finally` 续跑）+ Task 6（停止条接 `cancelTask(runningTask)`）✓
- 每条卡片独立取消/打断（插哪条哪条）→ Task 3 `unshift` 到队首 + Task 6 每卡片各自按钮 ✓
- 布局（排队区在 composer 上方、发送键始终发送、停止键移到运行条）→ Task 5 + Task 6 ✓
- 非目标（不编辑、顺序不持久化、不中途追加、不跨 session）→ 计划未引入这些，符合 ✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码；测试步骤含完整断言。两处「视实际确认」标注（`ui/button` 的 icon size 取值、`tasks-view` 既有 `activeTask` 其余引用）均给了明确的确认方法与回退路径，非占位。

**Type consistency：** `interruptWith(sessionId: string, taskId: string)` 在 manager 类型、service-ipc 联合、ui.ts 接口、service-client、preload、api.ts、use-tasks 七处签名一致；`QueuedItem = { id; sessionId; goal }` 在 overlay props 与 tasks-view 的 `.map` 一致；mutation 入参 `{ sessionId, taskId }` 与 `useCancelTask` 同形。`Session.pending: QueuedTurn[]`、`running: string | null` 在 Task 1 定义、Task 2/3 消费一致。

## Execution Handoff

见下方对话中的执行方式选择。
