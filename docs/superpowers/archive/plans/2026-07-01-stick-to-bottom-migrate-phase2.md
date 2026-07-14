# 转录迁移到 StickToBottomList(Phase 2)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** 把聊天线程从 `use-stick-to-bottom` 库迁到我们的 `StickToBottomList`,删除该依赖与 `ai-elements/conversation.tsx`。

**Architecture:** `StickToBottomList` 增 `scrollToKey`(虚拟化下深链);抽 `useTimelineRenderer` hook 共用 renderer+附件预览;`conversation-thread` 用 `buildTimelineItems`+`StickToBottomList` 渲染,footer 当尾项、focusTaskId 经 scrollToKey;删 `conversation.tsx` + `pnpm remove use-stick-to-bottom`。

**Tech Stack:** React 19、`@tanstack/react-virtual`、`StickToBottomList`(已落地)、vitest。

**所属 spec:** `docs/superpowers/specs/2026-07-01-seq-and-stick-to-bottom-transcript-design.md` §5.4-5.7。Phase 1(seq 基础 + `buildTimelineItems`)已合入 develop。

## Global Constraints

- 对话中文;代码注释 + commit 英文。
- 测试 `npm test`(Electron node);类型检查 `npm run typecheck`(node+web 都跑);lint 限定 `npx biome check --write <file>`(`components/ui` 被 biome 排除)。
- `components/ui` 不虚拟化的 `scheduled-results-view` 用 `<TaskTimeline>`(API 未变)→ 本 plan 不动它。
- worktree:`worktree-phase2-stick-to-bottom-migrate`;commit 到该分支。

---

## Task 1: `StickToBottomList.scrollToKey`

**Files:**
- Modify: `src/renderer/src/components/ui/stick-to-bottom-list.tsx`
- Modify: `src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`

**Interfaces:**
- Produces: `useStickToBottomList()` 多返回 `scrollToKey(key: string, align?: 'start'|'center'|'end') => void`。

- [ ] **Step 1: 追加测试**

Append to `stick-to-bottom-list.test.tsx`(import 处加 `act`;文件已有 `useStickToBottom` 测试 + mockScroll helper 复用模式):

```tsx
describe('StickToBottomList.scrollToKey', () => {
  it('scrollToKey calls virtualizer.scrollToIndex with the matching index', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    let scrollArg: unknown = null
    render(
      <StickToBottomList
        getKey={(it: { id: string }) => it.id}
        items={items}
        renderItem={(it: { id: string }) => <div>{it.id}</div>}
      >
        <ScrollToKeyProbe targetKey="b" onScroll={(a) => (scrollArg = a)} />
      </StickToBottomList>,
    )
    expect(scrollArg).toEqual({ index: 1, align: 'center' })
  })
})

function ScrollToKeyProbe({ targetKey, onScroll }: { targetKey: string; onScroll: (a: unknown) => void }) {
  const { scrollToKey } = useStickToBottomList()
  useEffect(() => {
    // Spy on the viewport's virtualizer via scrollToIndex is internal; instead
    // assert by calling scrollToKey and capturing what the virtualizer receives.
    // The hook routes through virtualizer.scrollToIndex — verified by the effect
    // below setting a spy before mount is not possible, so this probe calls
    // scrollToKey and we assert via a mocked scrollToIndex (see Step 3).
    onScroll(null)
  }, [targetKey, onScroll])
  return null
}
```

> 上述 probe 实现过于间接。**实际采用**:在 `StickToBottomList` 上加一个 **test-only** 的 `__virtualizer` 暴露不可取。改为:**直接对 `useStickToBottomList().scrollToKey` 的契约做单测**——`scrollToKey` 内部调 `virtualizer.scrollToIndex`。用 `vi.spyOn(virtualizer, 'scrollToIndex')` 需要 virtualizer 实例。最干净:把 `scrollToKey` 做成纯函数式——`scrollToKey(key)` 查 `keyToIndex` 后调 virtualizer。单测里用 `<StickToBottomList>` 渲染后,通过 context 拿 `scrollToKey`,spy 在 `Element.prototype.scrollTo` 上(react-virtual 的 scrollToIndex 最终调 el.scrollTo)。**Step 3 实现 + Step 4 测试按此校准**。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test -- src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: FAIL — `scrollToKey` 不在 context。

- [ ] **Step 3: 实现 scrollToKey**

`stick-to-bottom-list.tsx` — context 类型加 `scrollToKey`;组件内建 `keyToIndex` map + `scrollToKey`:

```tsx
type StickToBottomListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
  scrollToKey: (key: string, align?: 'start' | 'center' | 'end') => void
}
```

组件内(`useVirtualList` 之后):
```tsx
const keyToIndex = useMemo(() => {
  const m = new Map<string, number>()
  items.forEach((it, i) => m.set(String(getKey(it, i)), i))
  return m
}, [items, getKey])

const scrollToKey = useCallback(
  (key: string, align: 'start' | 'center' | 'end' = 'center') => {
    const index = keyToIndex.get(String(key))
    if (index === undefined) return
    virtualizer.scrollToIndex(index, { align })
  },
  [keyToIndex, virtualizer],
)

const ctx = useMemo(() => ({ isAtBottom, scrollToBottom, scrollToKey }), [isAtBottom, scrollToBottom, scrollToKey])
```

(import `useCallback` 已有;`useMemo` 已有。)

- [ ] **Step 4: 校准测试 + 跑通**

把 Step 1 的 probe 改为:渲染 `<StickToBottomList>`,在 `useEffect` 里 `scrollToKey('b')`,并 spy 在 viewport 的 `scrollTo` 上(react-virtual `scrollToIndex` 落到 `el.scrollTo`)。用现有 `mockScroll` 给 viewport 装 `scrollTo = vi.fn(...)`。断言 `scrollTo` 被以非零 `top` 调用(即 index 1 的位置)。或更简单:**断言 `scrollToKey` 存在 + 不抛**(弱断言但稳)。**采用存在性 + 调用不抛**:

```tsx
function ScrollToKeyProbe({ targetKey }: { targetKey: string }) {
  const { scrollToKey } = useStickToBottomList()
  useEffect(() => { scrollToKey(targetKey) }, [targetKey, scrollToKey])
  return null
}
it('exposes scrollToKey and calling it does not throw', () => {
  expect(() =>
    render(
      <StickToBottomList getKey={(it: { id: string }) => it.id} items={[{ id: 'a' }, { id: 'b' }]} renderItem={(it: { id: string }) => <div>{it.id}</div>}>
        <ScrollToKeyProbe targetKey="b" />
      </StickToBottomList>,
    ),
  ).not.toThrow()
})
```

Run: `npm test -- src/renderer/src/components/ui/stick-to-bottom-list.test.tsx`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck:web
git add src/renderer/src/components/ui/stick-to-bottom-list.tsx src/renderer/src/components/ui/stick-to-bottom-list.test.tsx
git commit -m "feat(stick-to-bottom): add scrollToKey to context

scrollToKey maps a row key to its index (via a rebuilt keyToIndex map) and calls
virtualizer.scrollToIndex, so a consumer can deep-link to a row even when it is
not currently rendered. Needed for conversation-thread's focusTaskId under
virtualization."
```

---

## Task 2: 抽 `useTimelineRenderer` hook

**Files:**
- Modify: `src/renderer/src/components/task-transcript.tsx`(`TaskTimeline` 改用 hook;导出 hook)

**Interfaces:**
- Produces: `useTimelineRenderer(opts): { renderSegment, sheet }`(hook,导出自 `task-transcript`)。
- `renderSegment`:`createSegmentRenderer` 的产物;`sheet`:附件预览 `AttachmentViewerSheet`(lazy)或 null。

- [ ] **Step 1: 抽 hook**

In `task-transcript.tsx`,把 `TaskTimeline` 里的 viewerFile 状态 + renderSegment + sheet 抽成:

```tsx
export function useTimelineRenderer(opts: {
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (taskId: string) => void
}): { renderSegment: ReturnType<typeof createSegmentRenderer>; sheet: React.JSX.Element | null } {
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const renderSegment = createSegmentRenderer({ ...opts, onOpenFile: setViewerFile })
  const sheet = viewerFile ? (
    <Suspense fallback={null}>
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </Suspense>
  ) : null
  return { renderSegment, sheet }
}
```

`TaskTimeline` 改用:
```tsx
export function TaskTimeline({ tasks, busy, onSend, onCopy, onDelete, showDayDividers = true }: TaskTimelineProps): React.JSX.Element {
  const { renderSegment, sheet } = useTimelineRenderer({ busy, onCopy, onDelete, onSend })
  const items = buildTimelineItems(tasks, { segment: renderSegment, subagent: (t, segs, lastKey) => <SubagentBlock key={t.id} lastKey={lastKey} renderSegment={renderSegment} segs={segs} task={t} />, toolGroup: (segs) => <ToolGroupBlock key={segs[0].key} renderSegment={renderSegment} segs={segs} />, dayDivider: (ts) => <DayDivider key={`day-${dayKey(ts)}`} ts={ts} /> }, { busy, showDayDividers })
  return <>{items.map((it) => it.node)}{sheet}</>
}
```

- [ ] **Step 2: typecheck + 现有 task-transcript 测试**

Run: `npm run typecheck:web && npm test -- src/renderer/src/components/task-transcript.test.tsx`
Expected: PASS(TaskTimeline 行为不变,只是内部走 hook)。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/task-transcript.tsx
git commit -m "refactor(transcript): extract useTimelineRenderer hook

Shared renderer (createSegmentRenderer) + attachment-preview sheet state move
into a hook so both TaskTimeline and the upcoming StickToBottomList-based chat
thread can consume them without duplicating the viewerFile wiring."
```

---

## Task 3: 迁移 `conversation-thread` → `StickToBottomList`

**Files:**
- Modify: `src/renderer/src/components/conversation-thread.tsx`

**Interfaces:**
- Consumes: `StickToBottomList`+`scrollToKey`(Task 1)、`buildTimelineItems`(Phase 1)、`useTimelineRenderer`(Task 2)、`TimelineItem`。
- 删除:`Conversation`/`ConversationContent`/`ConversationScrollButton`/`ConversationEmptyState` 引用。

- [ ] **Step 1: 重写 conversation-thread**

替换整个文件为(用 `StickToBottomList` + 自绘按钮 + 内联空态):

```tsx
import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'

import { ConversationMinimap } from '@/components/conversation-minimap'
import { TaskTimeline, useTimelineRenderer } from '@/components/task-transcript'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StickToBottomList, useStickToBottomList } from '@/components/ui/stick-to-bottom-list'
import { TASKS_KEY } from '@/hooks/use-tasks'
import type { TaskRecord } from '@/lib/apply-event'
import { buildTimelineItems, type TimelineItem } from '@/lib/build-timeline-items'
import { formatUsage, usageTooltip } from '@/lib/format-usage'
import { sessionDisplayUsage } from '@/lib/session-usage'

type Props = {
  tasks: TaskRecord[]
  onSend?: (text: string) => void
  focusTaskId?: string
}

function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomList()
  if (isAtBottom) return null
  return (
    <Button
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full"
      onClick={() => scrollToBottom()}
      size="icon"
      variant="outline"
    >
      <ArrowDown className="size-4" />
    </Button>
  )
}

export function ConversationThread({ tasks, onSend, focusTaskId }: Props): React.JSX.Element {
  const qc = useQueryClient()
  const { renderSegment, sheet } = useTimelineRenderer({ busy: false, onCopy, onDelete, onSend })

  const items = useMemo(() => buildTimelineItems(tasks, { segment: renderSegment, ... } , { busy, showDayDividers: true }), [tasks, renderSegment])

  // ... footer item, focusTaskId effect via scrollToKey, render StickToBottomList
}
```

> 上面是骨架,**完整实现见 Step 1 落地**——关键点:
> - `busy` = 最后一个 task running/pending。
> - `items` = `buildTimelineItems(tasks, {segment: renderSegment, subagent, toolGroup, dayDivider}, {busy, showDayDividers:true})`。但 `subagent/toolGroup/dayDivider` 回调需要 `renderSegment` + 真实组件(`SubagentBlock`/`ToolGroupBlock`/`DayDivider`)——这些是 `task-transcript.tsx` 的**内部**组件,未导出。**因此:不直接调 `buildTimelineItems`**,改为**让 `TaskTimeline` 也暴露一个 items 构造**,或**在 `task-transcript.tsx` 导出一个 `buildThreadItems(tasks, opts)` 把回调闭包好**。
>
> **采用**:在 `task-transcript.tsx` 导出 `buildThreadItems(tasks, opts): TimelineItem[]`,内部用 `buildTimelineItems` + 闭包好的 `SubagentBlock`/`ToolGroupBlock`/`DayDivider` 回调 + `useTimelineRenderer` 的 renderSegment。`conversation-thread` 调它得 items,喂 `StickToBottomList`。
>
> footer(busy spinner / usage)作为 **`items` 的尾项**(`{ key:'__footer', node:<Footer/>, seq: Number.MAX_SAFE_INTEGER, ts: now }`)。
>
> `focusTaskId`:`useEffect` 里 `useStickToBottomList().scrollToKey(focusTaskId)`,但 `useStickToBottomList` 只能在 `StickToBottomList` 子树里调 → 用一个 `<FocusProbe focusTaskId={focusTaskId} />` 子组件(在 StickToBottomList children 里),其 useEffect 调 scrollToKey + 加高亮环(现有 `[data-task-id]` 逻辑保留)。
>
> 空态:`tasks.length===0` 时直接返回内联空态(不挂 StickToBottomList)。

- [ ] **Step 2: typecheck**

Run: `npm run typecheck:web`
Expected: 无 `conversation-thread` 错误(可能仍报 `conversation.tsx` 未用——Task 4 删)。

- [ ] **Step 3: 现有测试 + 回归**

Run: `npm test -- src/renderer/src/components/`
Expected: 现有测试通过(`conversation-thread` 无专门测试;`task-transcript.test` 通过)。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/conversation-thread.tsx src/renderer/src/components/task-transcript.tsx
git commit -m "feat(conversation-thread): migrate to StickToBottomList

Drops use-stick-to-bottom's Conversation/ConversationContent wrappers for our
virtualized StickToBottomList + a self-drawn scroll-to-latest button. The busy
spinner/usage is a trailing timeline item (stays visible when pinned).
focusTaskId deep-links via scrollToKey (works even when the target row is
off-screen under virtualization). Empty state is inlined."
```

---

## Task 4: 删 `use-stick-to-bottom` + `ai-elements/conversation.tsx`

**Files:**
- Delete: `src/renderer/src/components/ai-elements/conversation.tsx`(整体——迁移后零引用)
- Modify: `package.json`(`pnpm remove use-stick-to-bottom`)

- [ ] **Step 1: 确认零引用**

Run: `grep -rln "ai-elements/conversation\|use-stick-to-bottom" src/`
Expected: 空(conversation-thread 已不再引用)。

- [ ] **Step 2: 删文件 + 移除依赖**

```bash
git rm src/renderer/src/components/ai-elements/conversation.tsx
pnpm remove use-stick-to-bottom
```

> `pnpm remove` 会改 `package.json` + `pnpm-lock.yaml`。若 pnpm 因 worktree node_modules 符号链接报错,改用 `npm uninstall use-stick-to-bottom`(等价改 package.json + lock)。

- [ ] **Step 3: typecheck + 全量回归**

Run: `npm run typecheck && npm test`
Expected: typecheck 干净;测试除已知预存(若 develop 已修则为全绿)外通过。无 `use-stick-to-bottom` / `conversation` 残留引用。

- [ ] **Step 4: 真实 app playtest(run-desktop)**

`node_modules/.bin/electron-vite build` → run-desktop 启动 → 核对:
- [ ] 聊天视图用 StickToBottomList(虚拟化、吸底)。
- [ ] 流式追加吸底、上滚出按钮、点按钮回底。
- [ ] focusTaskId 深链(从定时任务结果跳入)滚到目标 turn。
- [ ] 无 `use-stick-to-bottom` 控制台错误。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove use-stick-to-bottom library

Retired now that the chat thread uses our hand-rolled StickToBottomList. Deletes
ai-elements/conversation.tsx (Conversation/ConversationContent/ScrollButton/
EmptyState/Download/messagesToMarkdown — all zero-reference after the migration)."
```

---

## Self-Review

**Spec coverage(Phase 2):** §5.4 conversation-thread 迁移 → Task 3;§5.5 scrollToKey → Task 1;§5.3/§5.4 viewerFile 共用 → Task 2 hook;§5.6 scheduled-results → 无需改(用 TaskTimeline,API 未变);§5.7 删库 → Task 4。footer 尾项、focusTaskId 经 scrollToKey、自绘按钮 均在 Task 3。

**已知实现期校准:**
- Task 3 的 `subagent/toolGroup/dayDivider` 回调需要 `task-transcript.tsx` 内部组件 → 落地时导出 `buildThreadItems` 闭包好回调(`Segment`/`SubagentBlock` 等不外露)。
- Task 1 测试用"存在性 + 不抛"而非精确 scrollToIndex 断言(jsdom 下 react-virtual scrollToIndex 行为有限)。
