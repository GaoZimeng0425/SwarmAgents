# 定时任务 session 只读结果视图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把系统 session（「定时任务」）从可聊天的会话改为只读的"运行结果卡片列表"，移除输入框；每张卡片可展开看该次运行的完整只读转写。

**Architecture:** `TasksView` 按 `session.isSystem` 分流到新组件 `ScheduledResultsView`（无 composer / 浮层 / RightPanel）。转写渲染核心从 `conversation-thread.tsx` 抽到新模块 `task-transcript.tsx`（导出 `TaskTimeline`），聊天转写与卡片展开复用同一套渲染。纯数据映射 `buildScheduledRows` 抽到 `scheduled-rows.ts` 并单测。

**Tech Stack:** React 19 + TypeScript，TanStack Query/Router，zustand，date-fns，lucide-react，vitest（经 Electron node 运行）。

## Global Constraints

- 语言：对话回复用中文；**代码注释与 commit message 一律英文**。
- 测试运行器：用 `npm test`（`cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`）；**不要** `pnpm rebuild better-sqlite3`。
- 单文件运行：`npm test -- src/renderer/src/lib/scheduled-rows.test.ts`。
- Typecheck：`npm run typecheck`。
- Lint/format（scoped，避免全仓库重排）：`npx biome check --write <file>`。
- 系统 session id：`SYSTEM_SESSION_ID` from `@shared/system-session`（值 `'__system__'`）；判定用 `SessionSummary.isSystem`。
- 只改前端 renderer；不动后端、不动 `ScheduledCalendarView`、`ChatInput`、`session-list.tsx`。
- 频繁提交：每个 Task 末尾 commit。

---

### Task 1: 纯数据映射 `scheduled-rows.ts`

把"系统 session 顶层运行 task + cron 元数据"映射成结果行，并提供子树收集与耗时格式化。纯函数，先写测试。

**Files:**
- Create: `src/renderer/src/lib/scheduled-rows.ts`
- Test: `src/renderer/src/lib/scheduled-rows.test.ts`

**Interfaces:**
- Consumes: `TaskRecord` from `@/lib/apply-event`（字段：`id, parentTaskId?, goal, status, startedAt, summary, used?` 其中 `used?.wallMs`）；`CronRun` from `@shared/types/ui`（`{ id, jobId, taskId, status, error, ... }`）。
- Produces:
  - `type ScheduledRow = { taskId: string; name: string; status: TaskStatus; startedAt: number; durationMs?: number; summary: string | null; error: string | null }`
  - `buildScheduledRows(tasks: TaskRecord[], runs: CronRun[], jobs: ReadonlyArray<{ id: string; name: string | null }>): ScheduledRow[]`（仅顶层 task，按 startedAt 倒序）
  - `collectSubtree(tasks: TaskRecord[], rootId: string): TaskRecord[]`（root + 所有后代，含多级子 agent；root 不存在时返回 `[]`）
  - `formatDuration(ms: number): string`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/src/lib/scheduled-rows.test.ts`:

```ts
import type { CronRun } from '@shared/types/ui'
import { describe, expect, it } from 'vitest'

import type { TaskRecord } from './apply-event'
import { buildScheduledRows, collectSubtree, formatDuration } from './scheduled-rows'

const task = (over: Partial<TaskRecord> & { id: string }): TaskRecord => ({
  id: over.id,
  sessionId: '__system__',
  goal: 'goal',
  status: 'completed',
  workerId: null,
  summary: null,
  startedAt: 0,
  attachments: [],
  events: [],
  ...over,
})

const run = (over: Partial<CronRun> & { id: string; jobId: string; taskId: string | null }): CronRun => ({
  id: over.id,
  jobId: over.jobId,
  sessionId: '__system__',
  taskId: over.taskId,
  status: 'completed',
  triggeredAt: 0,
  endedAt: null,
  error: null,
  ...over,
})

describe('buildScheduledRows', () => {
  it('uses the cron job name when a run links the task to a named job', () => {
    const tasks = [task({ id: 't1', goal: 'raw goal', startedAt: 100, summary: 'done' })]
    const runs = [run({ id: 'r1', jobId: 'j1', taskId: 't1' })]
    const jobs = [{ id: 'j1', name: 'Daily report' }]
    const rows = buildScheduledRows(tasks, runs, jobs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ taskId: 't1', name: 'Daily report', status: 'completed', summary: 'done' })
  })

  it('falls back to task.goal when there is no run, no job, or a null job name', () => {
    const tasks = [task({ id: 't1', goal: 'fallback goal' })]
    expect(buildScheduledRows(tasks, [], []).at(0)?.name).toBe('fallback goal')
    const runs = [run({ id: 'r1', jobId: 'j1', taskId: 't1' })]
    expect(buildScheduledRows(tasks, runs, [{ id: 'j1', name: null }]).at(0)?.name).toBe('fallback goal')
  })

  it('surfaces the run error and the wallMs duration', () => {
    const tasks = [task({ id: 't1', status: 'failed', used: { tokens: 0, calls: 0, wallMs: 3200, usdCents: 0, cacheRead: 0, cacheWrite: 0 } })]
    const runs = [run({ id: 'r1', jobId: 'j1', taskId: 't1', status: 'failed', error: 'boom' })]
    const rows = buildScheduledRows(tasks, runs, [{ id: 'j1', name: 'Job' }])
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'boom', durationMs: 3200 })
  })

  it('excludes sub-agent tasks and sorts newest first', () => {
    const tasks = [
      task({ id: 'old', startedAt: 100 }),
      task({ id: 'new', startedAt: 200 }),
      task({ id: 'child', startedAt: 250, parentTaskId: 'new' }),
    ]
    const rows = buildScheduledRows(tasks, [], [])
    expect(rows.map((r) => r.taskId)).toEqual(['new', 'old'])
  })
})

describe('collectSubtree', () => {
  it('returns the root plus its transitive descendants', () => {
    const tasks = [
      task({ id: 'root' }),
      task({ id: 'a', parentTaskId: 'root' }),
      task({ id: 'b', parentTaskId: 'a' }),
      task({ id: 'other' }),
    ]
    const ids = collectSubtree(tasks, 'root').map((t) => t.id).sort()
    expect(ids).toEqual(['a', 'b', 'root'])
  })

  it('returns [] for an unknown root', () => {
    expect(collectSubtree([task({ id: 'x' })], 'missing')).toEqual([])
  })
})

describe('formatDuration', () => {
  it('formats ms / s / m+s', () => {
    expect(formatDuration(120)).toBe('120ms')
    expect(formatDuration(3200)).toBe('3.2s')
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- src/renderer/src/lib/scheduled-rows.test.ts`
Expected: FAIL —「Failed to resolve import './scheduled-rows'」或 `buildScheduledRows is not a function`。

- [ ] **Step 3: 写实现**

Create `src/renderer/src/lib/scheduled-rows.ts`:

```ts
import type { CronRun } from '@shared/types/ui'

import type { TaskRecord, TaskStatus } from './apply-event'

// One scheduled run, flattened for the read-only results list. Derived from the
// run's top-level task, enriched with cron metadata (job name, run error) when a
// cron_run links them. Pure; unit-tested.
export type ScheduledRow = {
  taskId: string
  name: string
  status: TaskStatus
  startedAt: number
  durationMs?: number
  summary: string | null
  error: string | null
}

// Map system-session top-level tasks to result rows, newest first. The cron job
// name (preferred over the raw goal) and the run error are joined via the
// cron_run whose taskId matches; a missing/null name falls back to task.goal so
// manual or legacy tasks still render.
export function buildScheduledRows(
  tasks: TaskRecord[],
  runs: CronRun[],
  jobs: ReadonlyArray<{ id: string; name: string | null }>
): ScheduledRow[] {
  const jobName = new Map(jobs.map((j) => [j.id, j.name]))
  const runByTaskId = new Map<string, CronRun>()
  for (const r of runs) if (r.taskId) runByTaskId.set(r.taskId, r)

  return tasks
    .filter((t) => !t.parentTaskId)
    .map((t) => {
      const run = runByTaskId.get(t.id)
      const name = (run ? jobName.get(run.jobId) : undefined) ?? t.goal
      return {
        taskId: t.id,
        name,
        status: t.status,
        startedAt: t.startedAt,
        durationMs: t.used?.wallMs,
        summary: t.summary,
        error: run?.error ?? null,
      }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
}

// A run's full task set: the root plus every spawned sub-agent descendant
// (transitive), so the expanded transcript shows sub-agent blocks too.
export function collectSubtree(tasks: TaskRecord[], rootId: string): TaskRecord[] {
  const root = tasks.find((t) => t.id === rootId)
  if (!root) return []
  const byParent = new Map<string, TaskRecord[]>()
  for (const t of tasks) {
    if (!t.parentTaskId) continue
    const arr = byParent.get(t.parentTaskId) ?? []
    arr.push(t)
    byParent.set(t.parentTaskId, arr)
  }
  const out: TaskRecord[] = [root]
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const child of byParent.get(id) ?? []) {
      out.push(child)
      stack.push(child.id)
    }
  }
  return out
}

// Human-readable run duration: "120ms" / "3.2s" / "2m 5s".
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- src/renderer/src/lib/scheduled-rows.test.ts`
Expected: PASS（3 个 describe 全绿）。

- [ ] **Step 5: typecheck + lint**

Run: `npx biome check --write src/renderer/src/lib/scheduled-rows.ts src/renderer/src/lib/scheduled-rows.test.ts && npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/scheduled-rows.ts src/renderer/src/lib/scheduled-rows.test.ts
git commit -m "feat(renderer): pure scheduled-rows mapping for cron results view"
```

---

### Task 2: 抽出转写渲染核心 `task-transcript.tsx`

把 `conversation-thread.tsx` 里的渲染基元（块组件 + `renderSegment` + 跨 task 交织）抽到新模块，导出 `TaskTimeline`，并让 `ConversationThread` 复用它。保持唯一渲染源。

**Files:**
- Create: `src/renderer/src/components/task-transcript.tsx`
- Modify: `src/renderer/src/components/conversation-thread.tsx`（删除已迁移的内联定义，改为导入 `TaskTimeline`）

**Interfaces:**
- Consumes: `taskSegments`, `Segment` from `@/lib/task-segments`；`groupSegments` from `@/lib/group-segments`；`TaskRecord` from `@/lib/apply-event`；`formatMessageTime, dayKey, formatDayLabel` from `@/lib/timeline`。
- Produces:
  - `function TaskTimeline(props: { tasks: TaskRecord[]; busy: boolean; onSend?: (text: string) => void; onCopy: (text: string) => void; onDelete?: (taskId: string) => void; showDayDividers?: boolean }): React.JSX.Element`
  - 内部 `createSegmentRenderer(opts)`、`ReasoningBlock`、`ToolImage`、`SubagentBlock`、`ToolGroupBlock`（不对外导出，除 `ToolImage` 可保留内部）。

- [ ] **Step 1: 创建 `task-transcript.tsx`（含全部渲染基元 + `TaskTimeline`）**

Create `src/renderer/src/components/task-transcript.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { Bot, Brain, CheckCircleIcon, ChevronRight, Copy, ExternalLink, Trash2, Wrench, XCircleIcon } from 'lucide-react'

import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { coerceProps, getUiRenderer } from '@/components/ui-renderers'
import type { TaskRecord } from '@/lib/apply-event'
import { extractImagePaths } from '@/lib/file-paths'
import { groupSegments } from '@/lib/group-segments'
import { type Segment, taskSegments } from '@/lib/task-segments'
import { dayKey, formatDayLabel, formatMessageTime } from '@/lib/timeline'
import { cn } from '@/lib/utils'

// ToolHeader needs an AI-SDK-shaped tool type + state; derive both from our segment.
function toolState(ok: boolean | null): 'input-available' | 'output-available' | 'output-error' {
  if (ok === null) return 'input-available'
  return ok ? 'output-available' : 'output-error'
}

// Collapsible "Thinking" block: open while reasoning streams, auto-collapses
// once the answer begins (live → false). The user can still toggle it.
function ReasoningBlock({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(live)
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) setOpen(false)
    wasLive.current = live
  }, [live])

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs">
      <button
        className="flex w-full items-center gap-2 text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Brain className={cn('size-3.5', live && 'animate-pulse text-primary')} />
        <span className="font-semibold uppercase tracking-wider">Thinking</span>
        <ChevronRight className={cn('ml-auto size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-3 whitespace-pre-wrap break-words text-[12px] text-muted-foreground/90 leading-relaxed">
          {text}
        </div>
      )}
    </div>
  )
}

// Inline preview for a tool-produced image (e.g. a screenshot). The sandboxed
// renderer can't read local files, so we pull bytes over IPC as a data URL and
// offer an "Open" button that hands the path to the OS.
function ToolImage({ path, showName = true }: { path: string; showName?: boolean }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.swarm.readImageFile(path).then((img) => {
      if (alive && img) setSrc(`data:${img.mimeType};base64,${img.data}`)
    })
    return () => {
      alive = false
    }
  }, [path])

  const name = path.split('/').pop() ?? path
  return (
    <div className="space-y-2">
      {src && (
        <button className="block cursor-pointer" onClick={() => void window.swarm.openPath(path)} type="button">
          <img alt={name} className="max-h-96 rounded-lg border border-border/40" src={src} />
        </button>
      )}
      {showName && (
        <button
          className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
          onClick={() => void window.swarm.openPath(path)}
          type="button"
        >
          <ExternalLink className="size-3.5" />
          <span className="font-mono">{name}</span>
        </button>
      )}
    </div>
  )
}

// Collapsible block grouping one spawned sub-agent's segments. Open while the
// sub-agent runs, shows a spinner, then auto-collapses once it finishes.
function SubagentBlock({
  task,
  segs,
  lastKey,
  renderSegment,
}: {
  task: TaskRecord
  segs: Segment[]
  lastKey: string | undefined
  renderSegment: (seg: Segment, isLiveTail: boolean) => React.JSX.Element
}): React.JSX.Element {
  const running = task.status === 'running' || task.status === 'pending'
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border/60 border-l-2 border-l-primary/50 bg-muted/20 py-3 pr-3 pl-4">
      <button
        className="flex w-full items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Bot className="size-3.5" />
        <span className="font-medium">Subagent</span>
        {task.agentDefId && <span className="font-mono text-muted-foreground/70">· {task.agentDefId}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {running && <Spinner className="size-3.5 text-primary" />}
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && segs.map((seg) => renderSegment(seg, seg.key === lastKey))}
    </div>
  )
}

// Collapsible block grouping several tool calls from one turn into a single row.
function ToolGroupBlock({
  segs,
  renderSegment,
}: {
  segs: Segment[]
  renderSegment: (seg: Segment, isLiveTail: boolean) => React.JSX.Element
}): React.JSX.Element {
  const running = segs.some((s) => s.kind === 'tool' && s.ok === null)
  const failed = segs.some((s) => s.kind === 'tool' && s.ok === false)
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const names = Array.from(new Set(segs.map((s) => (s.kind === 'tool' ? s.tool : ''))))

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs">
      <button
        className="flex w-full items-center gap-2 text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Wrench className={cn('size-3.5', running && 'animate-pulse text-primary')} />
        <span className="font-semibold uppercase tracking-wider">Tools</span>
        <span className="text-muted-foreground/60">{segs.length}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/60">{names.join(', ')}</span>
        {running ? (
          <Spinner className="size-3.5 text-primary" />
        ) : failed ? (
          <XCircleIcon className="size-3.5 text-red-600" />
        ) : (
          <CheckCircleIcon className="size-3.5 text-green-600" />
        )}
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-3 space-y-3 [&>*]:mb-0">{segs.map((seg) => renderSegment(seg, false))}</div>}
    </div>
  )
}

// Build the per-segment renderer. Closures (busy/onSend/onCopy/onDelete) are
// passed explicitly so both the live chat thread and the read-only results card
// share one rendering implementation. onDelete omitted → no Delete action.
function createSegmentRenderer(opts: {
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (taskId: string) => void
}): (seg: Segment, isLiveTail: boolean) => React.JSX.Element {
  const { busy, onSend, onCopy, onDelete } = opts

  const messageTime = (ts: number): React.JSX.Element => (
    <time
      className="px-1 text-[10px] text-muted-foreground/50 tabular-nums group-[.is-user]:text-right"
      dateTime={new Date(ts).toISOString()}
    >
      {formatMessageTime(ts)}
    </time>
  )

  const messageActions = (text: string, taskId: string): React.JSX.Element => (
    <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 group-[.is-user]:justify-end">
      <MessageAction label="Copy" onClick={() => onCopy(text)} tooltip="Copy message">
        <Copy className="size-3.5" />
      </MessageAction>
      {onDelete && (
        <MessageAction label="Delete" onClick={() => onDelete(taskId)} tooltip="Delete message">
          <Trash2 className="size-3.5" />
        </MessageAction>
      )}
    </MessageActions>
  )

  const renderSegment = (seg: Segment, isLiveTail: boolean): React.JSX.Element => {
    if (seg.kind === 'reasoning') {
      return <ReasoningBlock key={seg.key} live={isLiveTail && busy} text={seg.text} />
    }
    if (seg.kind === 'user') {
      return (
        <Message className="group" data-task-id={seg.taskId} from="user" key={seg.key}>
          <MessageContent>
            {seg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {seg.attachments.map((a, i) => (
                  <img
                    alt={a.name ?? 'attachment'}
                    className="size-20 rounded-lg border border-border/40 object-cover"
                    key={`${seg.key}-att-${i}`}
                    src={`data:${a.mimeType};base64,${a.data}`}
                  />
                ))}
              </div>
            )}
            <span className="whitespace-pre-wrap">{seg.text}</span>
          </MessageContent>
          {messageTime(seg.ts)}
          {messageActions(seg.text, seg.taskId)}
        </Message>
      )
    }
    if (seg.kind === 'assistant') {
      const images = extractImagePaths(seg.text)
      return (
        <Message className="group" data-task-id={seg.taskId} from="assistant" key={seg.key}>
          <MessageContent>
            <MessageResponse>{seg.text}</MessageResponse>
            {images.map((p) => (
              <ToolImage key={p} path={p} showName={false} />
            ))}
          </MessageContent>
          {messageTime(seg.ts)}
          {messageActions(seg.text, seg.taskId)}
        </Message>
      )
    }
    if (seg.kind === 'tool') {
      if (seg.tool === 'render_ui') {
        const spec = (seg.input ?? {}) as { type?: string; props?: unknown }
        const Renderer = typeof spec.type === 'string' ? getUiRenderer(spec.type) : undefined
        if (Renderer) {
          return (
            <Message className="group" from="assistant" key={seg.key}>
              <Renderer disabled={busy} onSend={onSend} props={coerceProps(spec.props)} />
            </Message>
          )
        }
        // Unknown type → fall through to the generic Tool card below.
      }
      const preview = seg.output ? seg.output.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined
      return (
        <Tool key={seg.key}>
          <ToolHeader
            preview={preview}
            state={toolState(seg.ok)}
            title={seg.tool}
            type={`tool-${seg.tool}` as `tool-${string}`}
          />
          <ToolContent>
            <ToolInput input={seg.input} />
            {seg.imagePath && <ToolImage path={seg.imagePath} />}
            <ToolOutput
              errorText={seg.ok === false ? (seg.output ?? '') : undefined}
              output={seg.ok === false ? undefined : seg.output}
            />
          </ToolContent>
        </Tool>
      )
    }
    // 'event' and 'error' both render as a compact muted details row.
    const label = seg.label
    return (
      <details
        className="group rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs transition-all hover:border-border hover:bg-muted/40"
        key={seg.key}
      >
        <summary className="flex cursor-pointer select-none items-center gap-2 font-mono text-[11px] text-muted-foreground/80 hover:text-muted-foreground">
          <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" />
          <span className="font-semibold uppercase tracking-wider">{label}</span>
        </summary>
        <ScrollArea className="mt-3 max-h-80 rounded-lg bg-background/50 ring-1 ring-border/30">
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] text-muted-foreground leading-relaxed">
            {seg.detail}
          </pre>
        </ScrollArea>
      </details>
    )
  }

  return renderSegment
}

type TaskTimelineProps = {
  tasks: TaskRecord[]
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (taskId: string) => void
  showDayDividers?: boolean
}

// Render a set of tasks' segments interleaved in true causal order: a top-level
// task contributes its segments individually (sorted by ts), a spawned sub-agent
// contributes ONE grouped block at its spawn time. Optional day dividers spine
// the timeline. The chat thread passes all session tasks with day dividers; the
// results card passes one run's subtree, read-only, without dividers.
export function TaskTimeline({
  tasks,
  busy,
  onSend,
  onCopy,
  onDelete,
  showDayDividers = true,
}: TaskTimelineProps): React.JSX.Element {
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)
  const renderSegment = createSegmentRenderer({ busy, onSend, onCopy, onDelete })

  const taskSegs = ordered.map((t) => ({ t, segs: taskSegments(t) }))
  let lastKey: string | undefined
  let lastTs = Number.NEGATIVE_INFINITY
  for (const { segs } of taskSegs) {
    for (const s of segs) {
      if (s.ts >= lastTs) {
        lastTs = s.ts
        lastKey = s.key
      }
    }
  }

  const items: Array<{ ts: number; order: number; node: React.JSX.Element }> = []
  let order = 0
  for (const { t, segs } of taskSegs) {
    if (t.parentTaskId) {
      items.push({
        ts: t.startedAt,
        order: order++,
        node: <SubagentBlock key={t.id} lastKey={lastKey} renderSegment={renderSegment} segs={segs} task={t} />,
      })
    } else {
      for (const item of groupSegments(segs)) {
        if (item.kind === 'single') {
          const seg = item.seg
          items.push({ ts: seg.ts, order: order++, node: renderSegment(seg, seg.key === lastKey) })
        } else {
          const first = item.segs[0]
          items.push({
            ts: first.ts,
            order: order++,
            node: <ToolGroupBlock key={first.key} renderSegment={renderSegment} segs={item.segs} />,
          })
        }
      }
    }
  }
  items.sort((a, b) => a.ts - b.ts || a.order - b.order)

  if (!showDayDividers) {
    return <>{items.map((it) => it.node)}</>
  }

  const now = Date.now()
  const out: React.JSX.Element[] = []
  let prevDay: string | undefined
  for (const it of items) {
    const d = dayKey(it.ts)
    if (d !== prevDay) {
      out.push(
        <div className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground/60" key={`day-${d}`}>
          <div className="h-px flex-1 bg-border/40" />
          <span className="font-medium uppercase tracking-wide">{formatDayLabel(it.ts, now)}</span>
          <div className="h-px flex-1 bg-border/40" />
        </div>
      )
      prevDay = d
    }
    out.push(it.node)
  }
  return <>{out}</>
}
```

- [ ] **Step 2: 重写 `conversation-thread.tsx` 复用 `TaskTimeline`**

Replace the entire contents of `src/renderer/src/components/conversation-thread.tsx` with:

```tsx
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { TaskTimeline } from '@/components/task-transcript'
import { Spinner } from '@/components/ui/spinner'
import { TASKS_KEY } from '@/hooks/use-tasks'
import type { TaskRecord } from '@/lib/apply-event'
import { formatUsage, usageTooltip } from '@/lib/format-usage'
import { sessionDisplayUsage } from '@/lib/session-usage'

type Props = {
  tasks: TaskRecord[]
  /** Start a new user turn with the given text (used by interactive UI cards). */
  onSend?: (text: string) => void
  /** Deep-link target: scroll to and briefly highlight this task's turn (e.g. a scheduled run). */
  focusTaskId?: string
}

export function ConversationThread({ tasks, onSend, focusTaskId }: Props): React.JSX.Element {
  const qc = useQueryClient()
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)

  // Deep-link: once the target task's turn is in the DOM, scroll it into view
  // and flash a highlight ring. Re-runs as tasks hydrate so it lands after the
  // initial stick-to-bottom autoscroll.
  useEffect(() => {
    if (!focusTaskId) return
    const el = document.querySelector<HTMLElement>(`[data-task-id="${focusTaskId}"]`)
    if (!el) return
    const id = window.setTimeout(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'rounded-lg')
      window.setTimeout(
        () => el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'rounded-lg'),
        2200
      )
    }, 120)
    return () => window.clearTimeout(id)
  }, [focusTaskId, tasks.length])

  const onCopy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    toast.success('Message copied to clipboard')
  }
  const onDelete = (taskId: string): void => {
    qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => prev.filter((t) => t.id !== taskId))
    toast.info('Message removed from view')
  }

  if (tasks.length === 0) {
    return (
      <Conversation className="flex-1">
        <ConversationContent>
          <ConversationEmptyState
            description="Send a message to start the conversation."
            icon={<MessagesSquare aria-hidden="true" className="size-6 opacity-60" />}
            title="No messages yet"
          />
        </ConversationContent>
      </Conversation>
    )
  }

  const last = ordered[ordered.length - 1]
  const busy = last.status === 'running' || last.status === 'pending'
  // Usage footer: cost + calls are the cumulative session total; the token
  // figure is the latest turn's context size. See sessionDisplayUsage.
  const usage = sessionDisplayUsage(tasks)

  return (
    <Conversation className="flex-1">
      {/* user-content re-enables text selection (globals.css disables it on chrome by default). */}
      <ConversationContent className="user-content mx-auto max-w-3xl">
        <TaskTimeline busy={busy} onCopy={onCopy} onDelete={onDelete} onSend={onSend} tasks={tasks} />
        {busy && (
          <div className="flex animate-pulse items-center gap-3 px-1 text-muted-foreground text-sm">
            <Spinner className="size-4 text-primary" />
            <span className="font-medium">{last.status === 'pending' ? 'Queued…' : 'Swarm is thinking…'}</span>
            {usage && (
              <span className="text-xs opacity-60" title={usageTooltip(usage)}>
                · {formatUsage(usage)}
              </span>
            )}
          </div>
        )}
        {!busy && usage && (
          <div
            className="flex items-center gap-2 border-border/30 border-t px-1 pt-4 text-muted-foreground text-xs opacity-60"
            title={usageTooltip(usage)}
          >
            <div className="size-1 rounded-full bg-border" />
            {formatUsage(usage)}
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
```

- [ ] **Step 3: typecheck + lint**

Run: `npx biome check --write src/renderer/src/components/task-transcript.tsx src/renderer/src/components/conversation-thread.tsx && npm run typecheck`
Expected: 无错误（注意 `task-transcript.tsx` 不能残留未使用导入；`conversation-thread.tsx` 不再 import 已迁移的图标/库）。

- [ ] **Step 4: 跑全量测试确认无回归**

Run: `npm test`
Expected: 全绿（`task-segments`/`group-segments` 等既有测试不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/task-transcript.tsx src/renderer/src/components/conversation-thread.tsx
git commit -m "refactor(renderer): extract TaskTimeline so chat + results share one transcript renderer"
```

---

### Task 3: 结果卡片列表 `ScheduledResultsView`

只读的运行结果卡片列表，复用 `TaskTimeline` 做展开转写，支持日历深链 `focusTaskId` 自动展开+滚动。

**Files:**
- Create: `src/renderer/src/components/views/scheduled-results-view.tsx`

**Interfaces:**
- Consumes: `buildScheduledRows, collectSubtree, formatDuration` from `@/lib/scheduled-rows`；`TaskTimeline` from `@/components/task-transcript`；`useAllCronJobs, useAllCronRuns` from `@/hooks/use-cron`；`TaskRecord` from `@/lib/apply-event`。
- Produces: `function ScheduledResultsView(props: { tasks: TaskRecord[]; focusTaskId?: string }): React.JSX.Element`

- [ ] **Step 1: 创建组件**

Create `src/renderer/src/components/views/scheduled-results-view.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { TaskStatus } from '@/lib/apply-event'
import { format } from 'date-fns'
import { CalendarClock, Check, ChevronRight, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'

import { ScrollArea } from '@/components/ui/scroll-area'
import { TaskTimeline } from '@/components/task-transcript'
import { useAllCronJobs, useAllCronRuns } from '@/hooks/use-cron'
import type { TaskRecord } from '@/lib/apply-event'
import { buildScheduledRows, collectSubtree, formatDuration } from '@/lib/scheduled-rows'
import { cn } from '@/lib/utils'

// Status → colored outcome icon, mirroring the calendar's run tones.
function StatusIcon({ status }: { status: TaskStatus }): React.JSX.Element {
  if (status === 'completed') return <Check className="size-4 text-emerald-500" />
  if (status === 'failed') return <X className="size-4 text-destructive" />
  if (status === 'running' || status === 'pending') return <Loader2 className="size-4 animate-spin text-primary" />
  return <span className="text-[10px] text-muted-foreground">●</span>
}

export function ScheduledResultsView({
  tasks,
  focusTaskId,
}: {
  tasks: TaskRecord[]
  focusTaskId?: string
}): React.JSX.Element {
  const { data: jobs = [] } = useAllCronJobs()
  const { data: runs = [] } = useAllCronRuns()
  const rows = buildScheduledRows(tasks, runs, jobs)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (taskId: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })

  // Deep-link (from the calendar's "查看运行记录 →"): expand the focused run's
  // card and scroll it into view with a brief highlight ring. Re-runs as tasks
  // hydrate (rows.length) so it lands once the card is in the DOM.
  useEffect(() => {
    if (!focusTaskId) return
    setExpanded((prev) => (prev.has(focusTaskId) ? prev : new Set(prev).add(focusTaskId)))
    const el = document.querySelector<HTMLElement>(`[data-card-id="${focusTaskId}"]`)
    if (!el) return
    const id = window.setTimeout(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background')
      window.setTimeout(
        () => el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background'),
        2200
      )
    }, 120)
    return () => window.clearTimeout(id)
  }, [focusTaskId, rows.length])

  const onCopy = (text: string): void => {
    void navigator.clipboard.writeText(text)
    toast.success('Message copied to clipboard')
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CalendarClock className="size-7 text-muted-foreground/40" />
        <p className="text-muted-foreground text-sm">还没有定时任务运行记录</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        {rows.map((row) => {
          const open = expanded.has(row.taskId)
          const preview = row.error ?? row.summary
          return (
            <div
              className="rounded-xl border border-border/60 bg-card/40 transition-colors"
              data-card-id={row.taskId}
              key={row.taskId}
            >
              <button
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
                onClick={() => toggle(row.taskId)}
                type="button"
              >
                <StatusIcon status={row.status} />
                <span className="min-w-0 flex-1 truncate font-medium text-sm">{row.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {format(row.startedAt, 'MM-dd HH:mm')}
                </span>
                {row.durationMs != null && (
                  <span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
                    {formatDuration(row.durationMs)}
                  </span>
                )}
                <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
              </button>
              {!open && preview && (
                <p
                  className={cn(
                    'line-clamp-2 px-4 pb-3 text-xs',
                    row.error ? 'text-destructive' : 'text-foreground/70'
                  )}
                >
                  {preview}
                </p>
              )}
              {open && (
                <div className="user-content flex flex-col gap-4 border-border/50 border-t p-4">
                  <TaskTimeline
                    busy={false}
                    onCopy={onCopy}
                    showDayDividers={false}
                    tasks={collectSubtree(tasks, row.taskId)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
```

- [ ] **Step 2: typecheck + lint**

Run: `npx biome check --write src/renderer/src/components/views/scheduled-results-view.tsx && npm run typecheck`
Expected: 无错误。

> 说明：组件依赖 hooks/DOM，逻辑单测已在 Task 1 覆盖；此处行为在 Task 4 的手动验证中检验。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/views/scheduled-results-view.tsx
git commit -m "feat(renderer): read-only scheduled results card list"
```

---

### Task 4: `TasksView` 分流 + 手动验证

系统 session 渲染 `ScheduledResultsView`，去掉 composer / 浮层 / RightPanel；普通 session 不变。

**Files:**
- Modify: `src/renderer/src/components/views/tasks-view.tsx`

**Interfaces:**
- Consumes: `ScheduledResultsView` from `@/components/views/scheduled-results-view`；已存在的 `sessionTasks`、`session`、`focusTaskId`。
- Produces: 无（顶层视图分流）。

- [ ] **Step 1: 加入 import**

In `src/renderer/src/components/views/tasks-view.tsx`, add to the imports block (near the other `@/components` imports):

```tsx
import { ScheduledResultsView } from '@/components/views/scheduled-results-view'
```

- [ ] **Step 2: 在主 `return` 之前插入系统 session 分支**

In `tasks-view.tsx`, immediately AFTER the line:

```tsx
  const taskOptions = { cwd, permissionMode, executionMode, agentType }
```

and BEFORE the existing `return (` line, insert:

```tsx
  // The system session ("定时任务") only surfaces scheduled-run RESULTS — it is
  // read-only: no composer, no send/queue overlay, no right panel. Everything
  // else (a normal chat) renders the full composer below.
  if (session?.isSystem) {
    return (
      <div className="flex h-full min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <ScheduledResultsView focusTaskId={focusTaskId} tasks={sessionTasks} />
        </div>
      </div>
    )
  }
```

- [ ] **Step 3: typecheck + lint**

Run: `npx biome check --write src/renderer/src/components/views/tasks-view.tsx && npm run typecheck`
Expected: 无错误。

> 注意：`focusTaskId` 是 `TasksView` 的入参（`{ focusTaskId }: { focusTaskId?: string }`），`sessionTasks` / `session` 已在上方计算；分支位于所有 hook 调用之后，符合 React hooks 规则。

- [ ] **Step 4: 跑全量测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 5: 手动验证（run-desktop / run skill）**

启动应用，逐项确认（对照 spec「测试」节）：
1. 点侧边栏顶部「定时任务」→ 呈现为**结果卡片列表**，**没有**底部输入框、没有发送/队列浮层、没有右侧面板。
2. 若存在历史运行：展开一张卡片 → 显示该次运行的完整只读转写（含工具卡/reasoning/子 agent 块），消息只有 Copy、**无 Delete**。
3. 侧边栏底部日历图标 → 某次运行点「查看运行记录 →」→ 跳进「定时任务」后对应卡片**自动展开并滚动高亮**。
4. 打开任意普通聊天 session → 输入框/发送/右侧面板**一切如常**，可正常发送消息。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/views/tasks-view.tsx
git commit -m "feat(renderer): render cron session as read-only results, drop composer"
```

---

## Self-Review

**Spec coverage：**
- 系统 session 去 composer/浮层/RightPanel → Task 4。
- 结果卡片列表（状态/名/时间/耗时/摘要，失败带 error） → Task 3 + Task 1（`buildScheduledRows`）。
- 展开完整只读转写（含子 agent） → Task 3（`TaskTimeline` + `collectSubtree`）。
- 唯一渲染源（抽 `task-transcript.tsx`，ConversationThread 复用） → Task 2。
- cron 名称关联 + 耗时 + 纯函数单测 → Task 1。
- 日历 `?task=` 深链自动展开+滚动 → Task 3（`data-card-id` + effect），Task 4 透传 `focusTaskId`。
- 普通 session 不变 → Task 4（仅在 `isSystem` 早返回）。
- 非目标（不动后端 / 日历 / ChatInput / session-list）→ 计划未触及这些文件。

**Placeholder scan：** 无 TBD/TODO；每个改码步骤含完整代码。

**Type consistency：** `ScheduledRow`、`buildScheduledRows`、`collectSubtree`、`formatDuration`、`TaskTimeline`（props 含 `tasks/busy/onSend?/onCopy/onDelete?/showDayDividers?`）在 Task 1/2/3 间签名一致；`ScheduledResultsView({ tasks, focusTaskId })` 与 Task 4 调用一致。`TaskStatus`、`TaskRecord`、`CronRun` 均来自既有模块，字段与现有定义对齐。
