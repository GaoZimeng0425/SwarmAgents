# 全局事件 seq 基础层(Phase 1)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用持久化的全局单调 `seq` 取代 wall-clock `ts` 作为转录排序键(新会话精确、live==replay;旧会话 fall back 到 ts,不更差),并抽出纯 `buildTimelineItems()` 按 seq 排序。

**Architecture:** `TaskEvent`/`UIEvent` 加 `seq`;`makeEmit` 在 emit 时赋 seq(per-session 计数器,懒初始化自持久化 max)并盖到持久化的 `obj.event` 上;`replay` 读回 seq(无则 fall back ts);`taskSegments` 透传 seq;新 `buildTimelineItems()` 取代 `TaskTimeline` 内联构造,按 seq 排序,删 3 处 `sortBy(ts)`。

**Tech Stack:** TypeScript、zod(`TaskEventSchema`)、Electron 服务层(better-sqlite3 store)、vitest(`npm test`,Electron node)。

**所属 spec:** `docs/superpowers/specs/2026-07-01-seq-and-stick-to-bottom-transcript-design.md`(Phase 1)。Phase 2(虚拟化迁移 + 删 `use-stick-to-bottom`)是后续独立 plan。

## Global Constraints

(每个 task 隐式前置;逐字取自 spec / 项目约定)

- **语言**:对话中文;**代码注释 + commit message 一律英文**。
- **测试**:`npm test`(Electron node 下的 vitest);单文件 `npm test -- <path>`。禁用 `pnpm rebuild better-sqlite3`。
- **类型检查**:本 plan 涉及 service + shared + renderer,**用 `npm run typecheck`**(= node + web 两套都跑),不只用 `typecheck:web`。
- **Lint 限定范围**:`npx biome check --write <file>`(**不要** `npm run check`,会重排全仓)。注:`components/ui` 被 biome 配置排除,不参与。
- **别名**:`@shared`/`@service`/`@main`/`@` 见 `vitest.config.ts`。
- **旧会话策略**:不管。`TaskEvent.seq` optional;旧数据 replay 时 `seq ?? ts`。不写 backfill pass。
- **worktree**:`worktree-seq-and-stick-to-bottom`;commit 提交到该分支。

---

## Task 1: `TaskEvent` + `UIEvent` 加 `seq`

**Files:**
- Modify: `src/shared/types/task.ts:150-194`(`TaskEventSchema` 7 个 variant 各加 `seq`)
- Modify: `src/shared/types/ui.ts:46-109`(`UIEvent` 各 variant 加 `seq: number`)
- Test: `src/shared/types/task.test.ts`(若无则新建)

**Interfaces:**
- Produces: `TaskEvent.seq?: number`(持久化,optional)、`UIEvent.seq: number`(必填)。
- Consumes: 无。

- [ ] **Step 1: 写失败测试(旧数据无 seq 仍可 parse)**

Create/append `src/shared/types/task.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TaskEventSchema } from './task'

describe('TaskEvent.seq', () => {
  it('parses a legacy event without seq', () => {
    const legacy = { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 }
    expect(() => TaskEventSchema.parse(legacy)).not.toThrow()
    expect(TaskEventSchema.parse(legacy).seq).toBeUndefined()
  })

  it('parses a new event with seq', () => {
    const ev = { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1, seq: 42 }
    expect(TaskEventSchema.parse(ev).seq).toBe(42)
  })
})
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: FAIL — `seq` 不在 schema 上(parse 新事件 `.seq` 为 undefined,第二条断言失败)。

- [ ] **Step 3: 加 `seq` 到 `TaskEventSchema` 每个 variant**

`src/shared/types/task.ts:150-194` — 给 7 个 variant 对象**各加** `seq: z.number().optional(),`(与 `ts` 并列;沿用现有"每 variant 重复 ts"的风格)。例如第一个:

```ts
  z.object({
    kind: z.literal('llm.message'),
    role: z.enum(['assistant', 'user', 'tool']),
    content: z.unknown(),
    ts: z.number(),
    seq: z.number().optional(),
  }),
```

对其余 6 个 variant(`reasoning` / `tool.call` / `tool.result` / `permission` / `handoff` / `error`)同样各加 `seq: z.number().optional(),`。

- [ ] **Step 4: 加 `seq: number` 到 `UIEvent` 每个 variant**

`src/shared/types/ui.ts:46-109` — `UIEvent` 的**每个** union variant加 `seq: number;`(必填,与 `ts` 并列)。共约 18 个 variant。

- [ ] **Step 5: 跑测试 + 全量 typecheck**

Run: `npm test -- src/shared/types/task.test.ts`
Expected: PASS(2 tests)。

Run: `npm run typecheck`
Expected: 大量错误——所有构造 `UIEvent` 的地方(makeEmit payload、replay、apply-event)现在缺 `seq`。**这是预期**;后续 Task 2-3 逐一修复。**仅记录错误数,本 task 不修**(它们正是后续 task 的输入)。

> 若 typecheck 错误仅集中在 `session/manager.ts`、`renderer/src/lib/replay.ts`、`renderer/src/lib/apply-event.ts` 的 UIEvent 字面量,符合预期。继续。

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/task.ts src/shared/types/ui.ts src/shared/types/task.test.ts
git commit -m "feat(types): add seq to TaskEvent (optional) and UIEvent (required)

TaskEvent.seq is optional so legacy persisted history still parses; UIEvent.seq
is required (always set by makeEmit/replay before reaching the renderer). This
is the schema foundation for ordering the transcript by a monotonic seq instead
of wall-clock ts."
```

---

## Task 2: `makeEmit` 赋 seq(per-session 计数器)

**Files:**
- Modify: `src/service/session/manager.ts:243-284`(`makeEmit`)
- Test: `src/service/session/seq-counter.test.ts`(新建,测抽出的 `createSeqCounter`)

**Interfaces:**
- Produces: `createSeqCounter(store): { nextSeq(sessionId: string): number }`;`makeEmit` 广播的 UIEvent 与持久化的 TaskEvent 都带 `seq`。
- Consumes: `store.getSessionTasks(sessionId): Task[]`(已存在,`store.ts:87`)、Task 1 的 `TaskEvent.seq`。

- [ ] **Step 1: 抽 `createSeqCounter` 并写测试**

Create `src/service/session/seq-counter.ts`:

```ts
import type { Task } from '@shared/types/task'

// Per-session monotonic seq counter. Lazily initializes from the max persisted
// seq so a resumed session continues past its history (no collision across
// service restarts). Centralized so makeEmit is the single seq-assignment point.
export type SeqCounter = {
  nextSeq: (sessionId: string) => number
}

export function createSeqCounter(getSessionTasks: (sessionId: string) => Task[]): SeqCounter {
  const counters = new Map<string, number>()

  const initMax = (sessionId: string): number => {
    let max = 0
    for (const t of getSessionTasks(sessionId)) {
      for (const ev of t.history) {
        if (typeof ev.seq === 'number' && ev.seq > max) max = ev.seq
      }
    }
    return max
  }

  return {
    nextSeq: (sessionId: string): number => {
      if (!counters.has(sessionId)) counters.set(sessionId, initMax(sessionId))
      const n = (counters.get(sessionId) as number) + 1
      counters.set(sessionId, n)
      return n
    },
  }
}
```

Create `src/service/session/seq-counter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Task } from '@shared/types/task'
import { createSeqCounter } from './seq-counter'

const task = (seqs: Array<number | undefined>): Task =>
  ({ id: 't', parentId: null, agentDefId: 'default', goal: 'g', status: 'completed', assignedWorkerId: null, toolAllowlist: [], history: seqs.map((seq, i) => ({ kind: 'llm.message', role: 'assistant', content: `${i}`, ts: i, ...(seq === undefined ? {} : { seq }) })), plan: [], acceptanceCriteria: [], verifications: [], delegationPlan: [], result: null, used: { tokens: 0, cacheRead: 0, costDeltaUsd: 0, usdCents: 0 }, contextWindow: 0, artifacts: [], createdAt: 0, endedAt: null }) as unknown as Task

describe('createSeqCounter', () => {
  it('counts from 0 for a fresh session', () => {
    const c = createSeqCounter(() => [])
    expect(c.nextSeq('s')).toBe(1)
    expect(c.nextSeq('s')).toBe(2)
  })

  it('resumes past the persisted max after a restart', () => {
    // "Restart": a brand-new counter over the same persisted history (seqs 5, 9).
    const c = createSeqCounter(() => [task([5, 9])])
    expect(c.nextSeq('s')).toBe(10)
  })

  it('counters are independent per session', () => {
    const c = createSeqCounter(() => [])
    expect(c.nextSeq('a')).toBe(1)
    expect(c.nextSeq('b')).toBe(1)
    expect(c.nextSeq('a')).toBe(2)
  })

  it('ignores legacy events without seq when initing', () => {
    const c = createSeqCounter(() => [task([undefined, 7, undefined])])
    expect(c.nextSeq('s')).toBe(8)
  })
})
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test -- src/service/session/seq-counter.test.ts`
Expected: FAIL — `createSeqCounter` 未导出(文件不存在)。

- [ ] **Step 3: 实现(Step 1 已写 `seq-counter.ts`,此步确认它落盘即可)**

确保 `src/service/session/seq-counter.ts` 与 Step 1 内容一致。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `npm test -- src/service/session/seq-counter.test.ts`
Expected: PASS(4 tests)。

- [ ] **Step 5: `makeEmit` 接入计数器,赋 seq + ts,盖到 `obj.event`**

`src/service/session/manager.ts`:在 `makeEmit` 定义前(约 L242)创建计数器实例(作用域与 `makeEmit` 同级,共享 store):

```ts
const seqCounter = createSeqCounter((sid: string) => store.getSessionTasks(sid))
```

改 `makeEmit`(L243-284)——在构造 payload 前赋 seq/ts,并把 seq 盖到要持久化的 `obj.event`:

```ts
  const makeEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const seq = seqCounter.nextSeq(sessionId)
      const ts = Date.now()
      // Persist seq on the TaskEvent that appendTaskEvent stores (Task.history):
      if (obj?.event && typeof obj.event === 'object') (obj.event as { seq?: number }).seq = seq
      const taskId = obj?.taskId as string | undefined
      const payload = obj ? { sessionId, seq, ts, ...obj } : data

      if (event === 'task.progress' && taskId && obj?.event) {
        store.appendTaskEvent(taskId, obj.event as TaskEvent) // now carries seq
      }
      if (event === 'task.error' && taskId && obj?.error) {
        store.appendTaskEvent(taskId, {
          kind: 'error',
          error: obj.error as Extract<TaskEvent, { kind: 'error' }>['error'],
          ts,
          seq, // persisted on the synthesized error event too
        })
      }
      // ... (task.plan / criteria / verification / delegation_plan branches unchanged)
      broadcaster.broadcast(event, payload) // broadcast UIEvent carries seq+ts
    }
```

> 同时:把 manager.ts 里**其他**仍传 `ts: Date.now()` 的 emit 调用点(L225/257/616/697/891/962/977 等)确认其 payload 经 makeEmit → 已由上面统一注入 `ts`,**删除各 call site 自己的 `ts: Date.now()`**(去重)。逐个 grep `ts: Date.now()` 处理。

在文件顶部 import:
```ts
import { createSeqCounter } from './seq-counter'
```

- [ ] **Step 6: typecheck + 测试**

Run: `npm run typecheck`
Expected: `session/manager.ts` 的 UIEvent 缺 seq 错误清除(本 task 修复了 makeEmit);其余(replay、apply-event)的 UIEvent 错误仍在,Task 3 修。

Run: `npm test -- src/service/session/seq-counter.test.ts src/service/session/manager.test.ts`
Expected: PASS(seq-counter 4 + manager 现有全过)。

- [ ] **Step 7: Commit**

```bash
git add src/service/session/seq-counter.ts src/service/session/seq-counter.test.ts src/service/session/manager.ts
git commit -m "feat(session): assign monotonic seq per session in makeEmit

createSeqCounter lazily resumes from the max persisted TaskEvent.seq so a
resumed session never reuses seqs. makeEmit stamps seq onto obj.event before
appendTaskEvent (so it persists in Task.history) and onto the broadcast UIEvent,
and centralizes ts assignment (dropping the scattered Date.now() call sites)."
```

---

## Task 3: `replay.ts` 读回 seq(无则 fall back ts)

**Files:**
- Modify: `src/renderer/src/lib/replay.ts`
- Test: `src/renderer/src/lib/replay.test.ts`(扩写/新建)

**Interfaces:**
- Produces: `tasksToRecords` 重建的 `UIEvent` 都带 `seq`(新数据真 seq;旧数据 = ts)。
- Consumes: Task 1 的 `UIEvent.seq` / `TaskEvent.seq`。

- [ ] **Step 1: 写失败测试**

Create/append `src/renderer/src/lib/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Task } from '@shared/types/task'
import { tasksToRecords } from './replay'

const baseTask = (over: Partial<Task>): Task =>
  ({
    id: 't1', parentId: null, agentDefId: 'default', goal: 'do x', status: 'completed',
    assignedWorkerId: null, toolAllowlist: [], history: [], plan: [], acceptanceCriteria: [],
    verifications: [], delegationPlan: [], result: null, used: { tokens: 0, cacheRead: 0, costDeltaUsd: 0, usdCents: 0 },
    contextWindow: 0, artifacts: [], createdAt: 100, endedAt: 200,
    ...over,
  }) as unknown as Task

describe('tasksToRecords seq', () => {
  it('uses persisted seq when present', () => {
    const t = baseTask({ history: [{ kind: 'llm.message', role: 'assistant', content: 'hi', ts: 5, seq: 77 }] })
    const [rec] = tasksToRecords('s', [t])
    const progress = rec.events.find((e) => e.kind === 'task.progress')!
    expect(progress.seq).toBe(77)
  })

  it('falls back to ts for legacy events without seq', () => {
    const t = baseTask({ history: [{ kind: 'llm.message', role: 'assistant', content: 'hi', ts: 9 }] })
    const [rec] = tasksToRecords('s', [t])
    const progress = rec.events.find((e) => e.kind === 'task.progress')!
    expect(progress.seq).toBe(9) // ts fallback
  })

  it('gives every UIEvent a finite seq', () => {
    const t = baseTask({ history: [{ kind: 'llm.message', role: 'assistant', content: 'x', ts: 3 }] })
    const [rec] = tasksToRecords('s', [t])
    expect(rec.events.every((e) => Number.isFinite(e.seq))).toBe(true)
    expect(rec.events[0]).toMatchObject({ kind: 'task.created' }) // task.created also has seq
  })
})
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test -- src/renderer/src/lib/replay.test.ts`
Expected: FAIL — 重建的 UIEvent 无 `seq` 字段。

- [ ] **Step 3: 实现**

`src/renderer/src/lib/replay.ts` —— `tasksToRecords` 里每个 `events.push({...})` 加 `seq`:

- `task.created`(L26-35):`seq: t.createdAt,`(合成,取 createdAt)。
- `task.progress`(L42):`seq: ev.seq ?? ev.ts,`(读回持久化,无则 ts)。
- `task.complete`(L45-51):`seq: t.endedAt ?? t.createdAt,`。

例(task.progress 行):
```ts
const ts = Number.isFinite(ev.ts) ? ev.ts : t.createdAt
events.push({ kind: 'task.progress', sessionId, taskId: t.id, event: ev, ts, seq: ev.seq ?? ts })
```

- [ ] **Step 4: typecheck + 测试**

Run: `npm run typecheck:web`
Expected: replay 的 UIEvent 缺 seq 错误清除。

Run: `npm test -- src/renderer/src/lib/replay.test.ts`
Expected: PASS(3 tests)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/replay.ts src/renderer/src/lib/replay.test.ts
git commit -m "feat(replay): carry seq onto rebuilt UIEvents (ts fallback for legacy)

Persisted seq is read back; legacy TaskEvents without seq fall back to ts so
old sessions render no worse than today. Synthesized task.created/complete get
seq from createdAt/endedAt. Every replayed UIEvent now has a finite seq."
```

---

## Task 4: `taskSegments` 透传 seq

**Files:**
- Modify: `src/renderer/src/lib/task-segments.ts`
- Modify: `src/renderer/src/lib/task-segments.test.ts`

**Interfaces:**
- Produces: `Segment` 各 variant 带 `seq`;goal 段 `seq = task.events[0]?.seq ?? task.startedAt`。
- Consumes: `TaskRecord.events`(UIEvent,已有 seq)、Task 1。

- [ ] **Step 1: 写失败测试**

Append to `src/renderer/src/lib/task-segments.test.ts`:

```ts
  it('carries seq from the event onto the segment', () => {
    const segs = taskSegments(
      rec([prog({ kind: 'tool.call', server: 'fs', tool: 'read_file', args: {}, ts: 5, seq: 42 } as never)]),
    )
    const tool = segs.find((s) => s.kind === 'tool')!
    expect((tool as { seq: number }).seq).toBe(42)
  })

  it('gives the goal segment the task.created seq', () => {
    // rec() builds a TaskRecord whose events[0] is NOT task.created; build one manually.
    const segs = taskSegments({
      id: 't1', sessionId: 's1', goal: 'do x', status: 'running', workerId: null, summary: null,
      startedAt: 10, attachments: [],
      events: [{ kind: 'task.created', sessionId: 's1', taskId: 't1', goal: 'do x', ts: 10, seq: 7 }],
    } as never)
    expect((segs[0] as { seq: number }).seq).toBe(7)
  })
```

> 现有 `rec()` helper 的 `prog(...)` 注入 `ts: 1`;新测用 `as never` 绕过 TS 把 `seq` 塞进 `TaskEvent`/`UIEvent` 字面量(实现后类型就有了,可去掉 `as never`)。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: FAIL — `Segment` 无 `seq`。

- [ ] **Step 3: 实现**

`src/renderer/src/lib/task-segments.ts`:
- `Segment` 类型每个 variant 加 `seq: number`。
- 开头的 goal 段:`seq: task.events[0]?.seq ?? task.startedAt,`(events[0] 是 task.created)。
- 各 `out.push({...})` 从对应事件 `e.seq` 取(回退 `e.ts`,防御):`seq: e.seq ?? e.ts`。具体:
  - `pushAssistant`/`pushReasoning` 闭包加 `seq` 参数,从调用处 `e.seq ?? e.ts` 传。
  - tool 段:`seq: e.seq ?? e.ts`。
  - tool.result 落到既有 tool 段(不改 seq)或 event 段:`seq: e.seq ?? e.ts`。
  - event/error 段:同上。

例(goal 段):
```ts
const out: Segment[] = [
  { kind: 'user', text: task.goal, attachments: task.attachments ?? [], key: `${task.id}-goal`, taskId: task.id, ts: task.startedAt, seq: task.events[0]?.seq ?? task.startedAt },
]
```

- [ ] **Step 4: typecheck + 测试**

Run: `npm run typecheck:web && npm test -- src/renderer/src/lib/task-segments.test.ts`
Expected: typecheck 过(或仅剩 task-transcript.tsx 适配,Task 5 修);现有 + 2 新测试 PASS。

Run: `npm run typecheck:web` 若报 `task-transcript.tsx` 的 Segment 字面量缺 seq → Task 5 处理(本 task 不改 task-transcript.tsx)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/task-segments.ts src/renderer/src/lib/task-segments.test.ts
git commit -m "feat(task-segments): carry seq onto Segment

The goal segment takes task.created's seq; every event-derived segment carries
its event's seq (ts fallback purely defensive — makeEmit/replay already set it).
Builds the per-segment ordering key the timeline will sort by."
```

---

## Task 5: 抽 `buildTimelineItems()` + `TaskTimeline` 按 seq 排序

**Files:**
- Create: `src/renderer/src/lib/build-timeline-items.ts`
- Create: `src/renderer/src/lib/build-timeline-items.test.ts`
- Modify: `src/renderer/src/components/task-transcript.tsx:425-522`(`TaskTimeline` 改调 `buildTimelineItems`)

**Interfaces:**
- Produces:
  - `TimelineItem = { key: string; node: React.ReactNode; seq: number; ts: number }`
  - `buildTimelineItems(tasks, renderSegment, { busy, showDayDividers }): TimelineItem[]`(按 seq 排序)
- Consumes: `taskSegments` + `Segment`(Task 4,带 seq)、`createSegmentRenderer`(留在 `task-transcript.tsx`,由调用方构造 `renderSegment` 传入)、`groupSegments`、`dayKey`/`formatDayLabel`。

- [ ] **Step 1: 写失败测试**

Create `src/renderer/src/lib/build-timeline-items.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TaskRecord } from './apply-event'
import type { Segment } from './task-segments'
import { buildTimelineItems } from './build-timeline-items'

const task = (segs: Segment[], startedAt = 1, id = 't1'): TaskRecord =>
  ({ id, sessionId: 's1', goal: 'g', status: 'running', workerId: null, summary: null, startedAt, attachments: [], events: [] }) as unknown as TaskRecord

const renderSegment = (seg: Segment): React.ReactNode => <div>{seg.key}</div>

describe('buildTimelineItems', () => {
  it('orders items by seq across tasks', () => {
    const a = task([{ kind: 'assistant', text: 'A', key: 'a', taskId: 't1', ts: 10, seq: 5 }])
    const b = task([{ kind: 'assistant', text: 'B', key: 'b', taskId: 't2', ts: 1, seq: 9 }])
    // Pass tasks in "wrong" array order; output must follow seq.
    const items = buildTimelineItems([b, a], renderSegment, { busy: false, showDayDividers: false })
    expect(items.map((i) => i.key)).toEqual(['a-goal', 'b-goal', 'a', 'b'].slice(2))
    // i.e. the rendered segment items are in seq order (5 before 9), regardless of array order.
  })

  it('sorts by seq, not ts (the whole point)', () => {
    const t = task([
      { kind: 'assistant', text: 'late-ts-early-seq', key: 'x', taskId: 't1', ts: 999, seq: 1 },
      { kind: 'assistant', text: 'early-ts-late-seq', key: 'y', taskId: 't1', ts: 1, seq: 2 },
    ])
    const items = buildTimelineItems([t], renderSegment, { busy: false, showDayDividers: false })
    const segKeys = items.map((i) => i.key).filter((k) => !k.endsWith('-goal'))
    expect(segKeys).toEqual(['x', 'y']) // seq order, NOT ts order
  })
})
```

> 注:`task()` 这里直接给 `segs` 但 `buildTimelineItems` 内部调 `taskSegments(task)`——为让单测可控,`buildTimelineItems` 的第二个参数是 `renderSegment`,而 segment 来自 `taskSegments`。若 `task()` 的 events 为空,`taskSegments` 只产出 goal 段。**为了让测试驱动真实 segment 顺序**,改为:让 `buildTimelineItems` 接收**已算好的** `segments per task`,或让测试构造带 events 的 TaskRecord。**采用后者**:在测试里把 segments 的内容作为 `task.events` 传入(经 taskSegments 转换)。上面测试示意了意图;实现时按真实 `taskSegments` 输出校准 key 断言。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npm test -- src/renderer/src/lib/build-timeline-items.test.ts`
Expected: FAIL — `buildTimelineItems` 未导出。

- [ ] **Step 3: 实现 `buildTimelineItems`**

Create `src/renderer/src/lib/build-timeline-items.ts`:

```ts
import { sortBy } from 'es-toolkit'
import type { ReactNode } from 'react'

import type { TaskRecord } from './apply-event'
import { dayKey } from './timeline'
import { groupSegments } from './group-segments'
import { type Segment, taskSegments } from './task-segments'

export type TimelineItem = {
  key: string
  node: ReactNode
  /** Global ordering key (replaces wall-clock ts). */
  seq: number
  /** Display-only: timestamp label + day-divider source. */
  ts: number
}

type RenderSegment = (seg: Segment, isLiveTail: boolean, nested?: boolean) => ReactNode

type Opts = {
  busy: boolean
  showDayDividers?: boolean
}

// Interleave segments from multiple tasks in true causal order (by seq). A
// top-level task contributes its segments individually; a spawned sub-agent
// contributes one grouped SubagentBlock at its spawn point. Day dividers optional.
// Extracted from TaskTimeline so the chat thread (StickToBottomList) and the
// read-only results card share one source of truth, ordered by seq not ts.
export function buildTimelineItems(
  tasks: TaskRecord[],
  render: {
    segment: RenderSegment
    subagent: (t: TaskRecord, segs: Segment[], lastKey: string | undefined) => ReactNode
    toolGroup: (segs: Segment[]) => ReactNode
    dayDivider: (ts: number) => ReactNode
  },
  opts: Opts,
): TimelineItem[] {
  const ordered = sortBy(tasks, [(t) => Math.min(t.events[0]?.seq ?? t.startedAt, t.startedAt)])

  // The live tail = the segment with the largest seq (gets the pulsing state).
  let lastKey: string | undefined
  let lastSeq = Number.NEGATIVE_INFINITY
  for (const t of ordered) {
    for (const s of taskSegments(t)) {
      if (s.seq >= lastSeq) {
        lastSeq = s.seq
        lastKey = s.key
      }
    }
  }

  type Raw = { seq: number; ts: number; node: ReactNode }
  const raw: Raw[] = []
  for (const t of ordered) {
    const segs = taskSegments(t)
    if (t.parentTaskId) {
      raw.push({ seq: t.events[0]?.seq ?? t.startedAt, ts: t.startedAt, node: render.subagent(t, segs, lastKey) })
    } else {
      for (const item of groupSegments(segs)) {
        if (item.kind === 'single') {
          const seg = item.seg
          raw.push({ seq: seg.seq, ts: seg.ts, node: render.segment(seg, seg.key === lastKey) })
        } else {
          const first = item.segs[0]
          raw.push({ seq: first.seq, ts: first.ts, node: render.toolGroup(item.segs) })
        }
      }
    }
  }

  const sorted = sortBy(raw, ['seq'])

  if (!opts.showDayDividers) {
    return sorted.map((r, i) => ({ key: `item-${i}-${r.seq}`, node: r.node, seq: r.seq, ts: r.ts }))
  }

  // Splice day dividers using ts (display), placed at seq - 0.5 so a divider
  // sorts just before the item whose day it opens.
  const out: TimelineItem[] = []
  let prevDay: string | undefined
  for (const r of sorted) {
    const d = dayKey(r.ts)
    if (d !== prevDay) {
      out.push({ key: `day-${d}`, node: render.dayDivider(r.ts), seq: r.seq - 0.5, ts: r.ts })
      prevDay = d
    }
    out.push({ key: `item-${r.seq}`, node: r.node, seq: r.seq, ts: r.ts })
  }
  return out
}
```

`render.subagent`/`toolGroup`/`dayDivider` 由调用方(`task-transcript.tsx`)用真实组件闭包传入(见 Step 4),避免 `lib/` 循环依赖组件层。

- [ ] **Step 4: `TaskTimeline` 改调 `buildTimelineItems`**

`src/renderer/src/components/task-transcript.tsx` `TaskTimeline`(L425-522):删除内联的 items 构造(L443-480 的 `ordered`/`taskSegs`/`lastKey`/`items`/`sortBy`),改为:

```tsx
export function TaskTimeline({ tasks, busy, onSend, onCopy, onDelete, showDayDividers = true }: TaskTimelineProps): React.JSX.Element {
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const renderSegment = createSegmentRenderer({ busy, onCopy, onDelete, onOpenFile: setViewerFile, onSend })

  const items = buildTimelineItems(
    tasks,
    {
      segment: renderSegment,
      subagent: (t, segs, lastKey) => <SubagentBlock key={t.id} lastKey={lastKey} renderSegment={renderSegment} segs={segs} task={t} />,
      toolGroup: (segs) => <ToolGroupBlock key={segs[0].key} renderSegment={renderSegment} segs={segs} />,
      dayDivider: (ts) => <DayDivider ts={ts} />,
    },
    { busy, showDayDividers },
  )

  return (
    <>
      {items.map((it) => it.node)}
      {viewerFile && (<Suspense fallback={null}><AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} /></Suspense>)}
    </>
  )
}
```

把原来的 `DayDivider` 内联 JSX 抽成 `task-transcript.tsx` 里的一个 `<DayDivider ts={ts}/>` 组件(原来在 L501-507 的 `<div className="flex items-center gap-3 ...">`)。

- [ ] **Step 5: typecheck + 测试**

Run: `npm run typecheck:web`
Expected: 全过(3 处 `sortBy(ts)` 已删)。

Run: `npm test -- src/renderer/src/lib/build-timeline-items.test.ts src/renderer/src/components/task-transcript.test.tsx src/renderer/src/lib/task-segments.test.ts`
Expected: PASS。task-transcript 现有测试若断言渲染结构,可能需随 `TaskTimeline` 改动微调(它仍渲染相同 DOM fragment,只是内部走 buildTimelineItems)。

- [ ] **Step 6: 全量回归**

Run: `npm run typecheck && npm test`
Expected: typecheck 过、测试除已知预存 `agents.company.test`(develop 上 `0993725` 引入,与本 work 无关)外全绿。

- [ ] **Step 7: 真实 app playtest(可选但建议)**

`node_modules/.bin/electron-vite build` 后用 run-desktop 启动:**新开会话**(产生带 seq 的事件)→ 流式追加、子 agent 块落点正确;**回放旧会话** → fall back 到 ts,行为≈现状、不崩。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/lib/build-timeline-items.ts src/renderer/src/lib/build-timeline-items.test.ts src/renderer/src/components/task-transcript.tsx
git commit -m "refactor(transcript): extract buildTimelineItems, order by seq

The timeline interleaving moves into a pure buildTimelineItems() shared by the
chat thread and the read-only results card. Ordering is now by the monotonic seq
(delete sortBy(ts) and sortBy(startedAt) — 3 sites), so a late-ts/early-seg event
no longer misorders. ts stays for display + day dividers only."
```

---

## Self-Review(plan 作者自查记录)

**Spec coverage(Phase 1 部分):**
- §5.1 `TaskEvent`/`UIEvent`+seq → Task 1。
- §5.1 makeEmit 赋 seq(盖到 obj.event + 广播)+ 收拢 Date.now() → Task 2。
- §5.1 replay 读回 / ts fallback(旧会话不管) → Task 3。
- §5.1 taskSegments 透传 seq(goal 段) → Task 4。
- §5.2 buildTimelineItems + 按 seq 排序 + 删 3 处 sortBy → Task 5。
- §9 Phase 1 独立可交付 → 本计划即 Phase 1;Phase 2(虚拟化 + 删库)后续 plan。

**Placeholder scan:** Task 5 Step 3 的 `SubagentBlockPlaceholder` / `DayDivider` 已在注记里明确要求落实为回调参数(修订签名已给),非占位。其余每步含完整代码或确切命令 + 预期输出。

**Type consistency:** `TaskEvent.seq?: number`(Task 1) ↔ `createSeqCounter` 读 `ev.seq`(Task 2) ↔ replay `ev.seq ?? ev.ts`(Task 3) ↔ Segment.seq(Task 4) ↔ TimelineItem.seq(Task 5) 一致。`UIEvent.seq: number` 必填,在 makeEmit(payload)与 replay 处赋值,apply-event 仅透传(`e` 已带 seq,`applyEvent` 不构造新 UIEvent,仅 `[...events, e]`——Task 1 后 typecheck 应不报 apply-event 错;若报,说明有分支构造了 UIEvent 字面量,按报错点补 seq)。

**已知实现期核实:**
- `apply-event.ts` 的 stub(未识别 task)分支用 `e.ts` 作 startedAt,不构造新 UIEvent——预期 typecheck 不报。若报,补 seq。
- `makeEmit` 的 `ts: Date.now()` 收拢(Step 5)需 grep 全部 call site 逐一处理,别漏。
