# 全局事件 seq + 转录迁移到 StickToBottomList 设计

- 日期: 2026-07-01
- 分支: `worktree-seq-and-stick-to-bottom`
- 状态: 设计待评审
- 关联: `docs/superpowers/specs/2026-06-30-stick-to-bottom-list-design.md`(StickToBottomList 原语,已合入 develop)

## 1. 背景与动机

两个已存在的问题在此汇合,适合一次性解决:

### 1.1 转录排序依赖 wall-clock `ts`,脆弱

`TaskTimeline`(`src/renderer/src/components/task-transcript.tsx`)和 `conversation-thread.tsx` 共有 **3 处** `sortBy` 用时间戳排序:

- `task-transcript.tsx:434` `sortBy(tasks, ['startedAt'])`
- `task-transcript.tsx:480` `sortBy(items, ['ts', 'order'])`
- `conversation-thread.tsx:31` `sortBy(tasks, ['startedAt'])`

`ts` 是 wall-clock,实测不可靠——仓库已为此修过两次:
```
73fa2d0 fix(renderer): safeTs falls back to now, not epoch 0
9debf03 fix(renderer): guard TaskTimeline <time dateTime> against non-finite ts
```
`ts` 会出现 epoch 0 / NaN;`sortBy` 对 NaN 比较全返回 false → 顺序未定义。`safeTs` 修了**显示**,但**排序**仍坏。根因:把"显示时间"当成了"排序键"。

事件模型(`shared/types/ui.ts` 的 `UIEvent`)只有 `ts`,设计上就拿时间戳当序号(注释:*"Each event carries a server-side timestamp so the UI can render a linear timeline without needing its own clock"*)。但事件是 **streamed from Main → Renderer**——到达序本身就是因果序;用更差的键(wall-clock)重新排是把流自带的因果序扔掉重推。

### 1.2 聊天线程不虚拟化,且 `use-stick-to-bottom` 库可弃

- `conversation-thread.tsx` → `ai-elements/conversation.tsx`(直接套 `use-stick-to-bottom` 库的 `StickToBottom`)→ 全量渲染 `<TaskTimeline/>`,长会话 DOM 失控。
- 我们已在 develop 上落地通用原语 `StickToBottomList`(`@tanstack/react-virtual` + 手写吸底 + context,见关联 spec)。但它是 **items 式、虚拟化**,而 `TaskTimeline` 现在返回 **fragment of nodes**(契合 `ConversationContent` 的子节点式 API)——形态不匹配。
- `use-stick-to-bottom` 库仅 `ai-elements/conversation.tsx` 一处使用(被 `conversation-thread.tsx` 引用)。库自带原生滚动条 scroller,违反项目"所有滚动用 ScrollArea"约定。

## 2. 目标

合成一个 effort,一次性:

1. **引入全局单调 `seq`** 作为事件的排序键(emit 时赋值、持久化、回放读回),`ts` 退为纯显示用。根治 1.1 的脆弱。
2. **`TaskTimeline` 的交织逻辑抽成纯 `buildTimelineItems()`**,按 `seq` 输出 `Item[]`(取代 `sortBy(ts)`)。
3. **聊天线程迁到 `StickToBottomList`**(消费 items,虚拟化 + 吸底),**删除 `use-stick-to-bottom`** 依赖与 `Conversation`/`ConversationContent`/`ConversationScrollButton`。
4. `scheduled-results-view`(第二个 `TaskTimeline` 消费者)适配 items 输出,普通非虚拟化渲染。

## 3. 关键决策(已与用户确认)

| 维度 | 决策 | 理由 |
|------|------|------|
| seq 落地 | **持久化 seq**(emit 赋值 + 落盘 + replay 读回;旧会话 backfill) | 用户选 A。live==replay、子 agent spawn 位置处处正确;半解法(B:仅 renderer 派生)在回放时丢掉 per-task 持久化里的原始交错,位置会与 live 不一致 |
| 结果卡片 | **非虚拟化**普通列表(YAGNI) | 只读、不吸底;日后特别长再升级 VirtualList |
| 形状 | 抽 `buildTimelineItems()` 纯函数,两消费者共用 | 单一事实源,消除"3 处 sortBy 重复"这种分叉;替代方案(各消费者自建交织)直接否决 |
| seq 粒度 | per-session 单调递增 | 时间线是 per-session;跨会话不需统一序 |

## 4. 范围与非目标

**范围内:**
- `UIEvent` 加 `seq`;`makeEmit` 统一赋 `seq`+`ts`;replay 读回 / 旧数据 backfill;`taskSegments` 透传 `seq`。
- 抽 `buildTimelineItems()`;`TaskTimeline` 改调它;删 3 处 `sortBy(ts/startedAt)`。
- `conversation-thread.tsx` 迁到 `StickToBottomList`(含 footer 尾项、`focusTaskId` 经 `scrollToKey`、viewerFile 共用 hook)。
- `StickToBottomList` context 增 `scrollToKey(key)`。
- `scheduled-results-view` 适配 items。
- 删 `Conversation`/`ConversationContent`/`ConversationScrollButton`;`pnpm remove use-stick-to-bottom`。

**非目标(YAGNI):**
- 不虚拟化 `scheduled-results-view`。
- 不动 `ConversationMinimap`(读 tasks,预期不受影响——实现期核实)。
- 不删除孤儿 `task-timeline.tsx`(无关,另行处理)。
- 不引入跨 session 的全局序。

## 5. 架构

### 5.1 seq 基础层

**`TaskEvent` 加 `seq?: number`**(`shared/types/task.ts`,`TaskEventSchema` 各 variant)。**optional**——旧会话历史无 seq 也能 parse。`TaskEvent` 持久化在 `Task.history`(经 `store.appendTaskEvent`),是 seq 落盘的真正载体。

**`UIEvent` 加 `seq: number`**(必填,`shared/types/ui.ts` 各 variant)——供 live 广播 + 渲染排序;到达 renderer 时(makeEmit 广播 / replay 重建)必有。

> **持久化路径(读真实代码后修正):** service 持久化的是 `Task.history: TaskEvent[]`,**不是** renderer 的 `TaskRecord.events`(后者是 replay 重建、不落盘)。所以 seq 必须在 `TaskEvent` 上,UIEvent 也要带。
>
> **旧会话策略:不管。** 旧会话的 TaskEvent 无 seq → replay 时 `seq` fall back 到 `ts`(= 现状、不更差);不写 backfill pass、不做精确交错还原。只有新会话(seq 已持久化)精确、live==replay。

**`makeEmit` 统一赋 `seq` + `ts`**(`src/service/session/manager.ts:243`):

```ts
// per-session monotonic counter; initialized on session load to max(existing seq)+1
const seqCounters = new Map<string, number>()
const nextSeq = (sessionId: string): number => {
  const n = (seqCounters.get(sessionId) ?? 0) + 1
  seqCounters.set(sessionId, n)
  return n
}

const makeEmit =
  (sessionId: string) =>
  (event: string, data: unknown): void => {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
    const seq = nextSeq(sessionId)
    const ts = Date.now()
    // Stamp seq on the persisted TaskEvent BEFORE appendTaskEvent (makeEmit persists obj.event):
    if (obj?.event && typeof obj.event === 'object') (obj.event as { seq?: number }).seq = seq
    // Broadcast UIEvent carries seq + ts; callers no longer pass ts: Date.now() themselves.
    const payload = obj ? { sessionId, seq, ts, ...obj } : data
    // ... (taskId extraction, appendTaskEvent, broadcast unchanged)
  }
```

> 注意:`{ sessionId, seq, ts, ...obj }` 中 `obj` 不含 `seq`/`ts`,故不会被覆盖。同时**收拢散落 8 处的 `ts: Date.now()`**(去重):各 call site 改为不传 `ts`。session 加载时 `seqCounters` 初始化为该 session 已持久化事件的 `max(seq)+1`,跨重启续号。

**`replay.ts`**(`src/renderer/src/lib/replay.ts`):
- `task.progress` 的 UIEvent:`seq: ev.seq ?? ev.ts`(新数据用持久化 seq;旧数据 fall back 到 ts)。
- 合成的 `task.created`/`task.complete`:`seq` 取其 `ts`(`createdAt`/`endedAt`)。
- 排序键改 `seq`(替 `orderBy(ts)`)。旧会话因 fall back 到 ts,行为≈现状。

**`taskSegments`**(`src/renderer/src/lib/task-segments.ts`):Segment 各 variant 加 `seq`(必填);goal(用户首条)段 `seq = task.events[0]?.seq ?? task.startedAt`(`events[0]` 即 `task.created`);其余段读 `e.seq`。UIEvent 到达时已有 seq(makeEmit 或 replay 已赋)。

### 5.2 `buildTimelineItems()` + `Item`

新建 `src/renderer/src/lib/build-timeline-items.ts`(纯函数,与 `task-segments` 同层;易单测):

```ts
export type TimelineItem = {
  key: string
  node: React.ReactNode
  seq: number   // 排序键
  ts: number    // 仅显示/日期分隔用
}

export function buildTimelineItems(
  tasks: TaskRecord[],
  opts: {
    busy: boolean
    onSend?: (text: string) => void
    onCopy: (text: string) => void
    onDelete?: (taskId: string) => void
    onOpenFile?: (file: ViewerFile) => void
    showDayDividers?: boolean
  },
): TimelineItem[]
```

抽自现 `TaskTimeline` 的 `items` 构造段(`task-transcript.tsx:443-480`):
- `createSegmentRenderer(opts)` 不变(产出 segment→node)。
- 顶层 task → 各 segment 入列;子 agent → 一个 `SubagentBlock`;连续工具 → `ToolGroupBlock`。
- 每项 `seq` 取自 segment.seq(或 SubagentBlock 的 task min-seq)。
- **删** `sortBy(tasks, ['startedAt'])`(改按 task 的 min-seq 排)和 `sortBy(items, ['ts', 'order'])`(改 `sortBy(items, ['seq'])`)。
- 日期分隔行:迭代(已按 seq 排序的)items,`dayKey(ts)` 变化处插入分隔行;分隔行 `seq` 取下一条的 `seq`(稳定)。

### 5.3 `TaskTimeline` 改造(结果卡片用)

`TaskTimeline` 组件保留(仍是 `scheduled-results-view` 的 API),内部改为调 `buildTimelineItems` 后**非虚拟化**渲染(现有 ScrollArea 包裹)。viewerFile 状态 + `AttachmentViewerSheet` 保留在此组件。

### 5.4 聊天线程 → `StickToBottomList`(`conversation-thread.tsx`)

- 调 `buildTimelineItems(tasks, opts)` 得 items,喂 `<StickToBottomList items getKey renderItem>`。
- **页脚(busy spinner / usage)**作为 items 的**尾项**(`{ key: '__footer', node: <Footer/>, seq: Number.MAX_SAFE_INTEGER, ts: now }`),随内容滚动、吸底时可见。不另设 footer 槽。
- **`focusTaskId` 深链**:虚拟化下目标行可能未渲染,DOM `scrollIntoView` 失效 → 改用 `useStickToBottomList().scrollToKey(focusTaskId)`(见 5.5),滚动落定后再加高亮环(现有 ring 逻辑保留)。
- **`viewerFile`(附件预览)**:抽 `useTimelineRenderer(opts)` hook → `{ renderer, sheet }`,聊天线程与结果卡片共用,避免 viewerFile 状态重复。`sheet` 即 `<AttachmentViewerSheet>`(lazy)。
- **空态**:`tasks.length === 0` 时**不挂 `StickToBottomList`**,直接渲染空态占位(把现 `ConversationEmptyState` 的 markup 内联到 `conversation-thread`,不再经 `Conversation`/`ConversationContent` 包裹)。
- **滚动到底部按钮**:自绘,读 `useStickToBottomList`(沿用 `StickToBottomList` 已验证模式),取代 `ConversationScrollButton`。
- **`ConversationMinimap tasks={tasks}`**:保留,不动(实现期确认其不依赖被删导出)。
- 删 `Conversation`/`ConversationContent`/`ConversationScrollButton` 引用。

### 5.5 `StickToBottomList` 增量(`stick-to-bottom-list.tsx`)

context value 增 `scrollToKey`:

```ts
type StickToBottomListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
  scrollToKey: (key: string, align?: 'start' | 'center' | 'end') => void  // 新增
}
```

实现:`StickToBottomList` 每次渲染从 `items`+`getKey` 重建一个 `Map<key, index>`;`scrollToKey(key, align)` 查 index 后调 `virtualizer.scrollToIndex(index, { align })`。即使目标行未渲染,react-virtual 也会先滚到位再挂载。key 未找到时 no-op。

> 这是对已落地原语的小幅扩展;`scrollToKey` 是纯增量,不改既有 API 语义。

### 5.6 `scheduled-results-view` 适配

调 `buildTimelineItems` 后普通 `.map(it => it.node)` 渲染(现有 ScrollArea),`showDayDividers=false` 不变。非虚拟化。

### 5.7 删除 `use-stick-to-bottom`

- `conversation-thread` 迁移后,`Conversation`/`ConversationContent`/`ConversationScrollButton` 零引用 → 删。
- `ConversationEmptyState`/`ConversationDownload`/`messagesToMarkdown`:实现期 grep 确认;仅 `conversation.tsx` 内部/未引用 → 保留为纯函数或随删。
- `pnpm remove use-stick-to-bottom`(从 `package.json` 移除)。

## 6. 数据流(seq 贯穿)

```
service makeEmit  ──assign seq+ts──►  UIEvent  ──broadcast──►  renderer (live)
                            │
                            └──persist──►  TaskRecord.events (with seq)
                                                  │
                            replay.ts ◄──load─────┘  (read seq; backfill old)
                                │
                                ▼
                          taskSegments (carry seq)
                                │
                                ▼
                       buildTimelineItems (sort by seq)
                                │
                ┌───────────────┴────────────────┐
                ▼                                 ▼
   conversation-thread                   scheduled-results-view
      → StickToBottomList                  → plain map (non-virt)
```

## 7. 边界与已知限制

- ✅ **live==replay(新会话)**:seq 持久化在 `TaskEvent`,replay 读回;新事件处处一致。
- ⚠️ **旧会话(不管)**:历史 TaskEvent 无 seq → replay fall back 到 `ts`,行为≈现状(可能 NaN/粗排),不写 backfill、不做精确交错还原。新会话不受影响。
- ✅ **`focusTaskId` 深链**:`scrollToKey` 经 `scrollToIndex` 即使未渲染也能滚到。
- ⚠️ **`ConversationMinimap`**:读 tasks、预期不受影响,实现期核实其不依赖 `ts` 排序或被删导出。
- ⚠️ **service 持久化路径**:实现期确认 `TaskRecord.events` 的落盘确实带上 makeEmit 注入的 seq(预期是同一对象引用,但要核实 broadcast 与 persist 是否同源)。
- ⚠️ **seq 计数器初始化**:session 加载时 `max(seq)+1`;若旧数据 backfill 在 renderer 侧而计数器在 service 侧,二者用不同推导——接受(service 计数器只管新事件续号,旧事件 seq 由 replay backfill,二者不相交)。

## 8. 测试策略

**单元测试:**
- `makeEmit` seq:per-session 单调递增、跨 session 独立(session/service 层,可能需在 service 测试里验)。
- `replay.ts`:旧数据(无 seq)backfill 确定性、新数据 seq 读回、顺序正确。
- `taskSegments`:seq 透传。
- `buildTimelineItems`:按 seq 排序、子 agent `SubagentBlock` 落点、日期分隔、`__footer` 尾项 seq 最大(取代当前依赖 ts 的断言)。
- `StickToBottomList.scrollToKey`:key→index→scrollToIndex 调用(jsdom mock,沿用现有 mockScroll 模式)。

**回归:** `TaskTimeline`/`task-segments` 现有测试随契约改动更新(返回 items 而非 fragment)。

**真实 app playtest(run-desktop):**
- 长会话流式追加 → 吸底、不闪。
- **回放一个旧会话**(pre-seq 数据) → 顺序合理、子 agent 块位置可接受、无 NaN 乱序。
- **`focusTaskId` 深链**(从定时任务结果跳进来) → 滚到目标 turn + 高亮。
- 切换会话 → 计数器续号正确、不串。

## 9. 实现步骤概要(供 writing-plans 细化)

建议**分两阶段**(可分别 review/验证):
1. **seq 基础层**:`UIEvent`+seq → `makeEmit` 赋值 → replay 读回/backfill → `taskSegments` 透传 → `buildTimelineItems` 抽出 + 按 seq 排序(删 3 处 sortBy)。→ 验证:seq 单测、现有转录测试更新通过、app 内回放旧会话顺序正确。**此阶段即可独立交付**(转录顺序已根治,仍用现有非虚拟化渲染)。
2. **虚拟化迁移**:`StickToBottomList`+`scrollToKey` → `conversation-thread` 迁移 → `scheduled-results-view` 适配 → 删 `use-stick-to-bottom`。→ 验证:playtest 清单 + `pnpm ls use-stick-to-bottom` 不存在。

## 10. 开放问题

无。命名(`buildTimelineItems`/`TimelineItem`/`useTimelineRenderer`/`scrollToKey`)为实现期可微调,不改变设计。
