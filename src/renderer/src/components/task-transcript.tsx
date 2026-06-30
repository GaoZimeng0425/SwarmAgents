import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { sortBy, uniq } from 'es-toolkit'
import {
  Bot,
  Brain,
  CheckCircleIcon,
  ChevronRight,
  Copy,
  ExternalLink,
  Trash2,
  Wrench,
  XCircleIcon,
} from 'lucide-react'

import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import type { ViewerFile } from '@/components/attachment-viewer-sheet'
import { ScrollArea } from '@/components/ui/scroll-area'

// Lazy-loaded so the heavy pdf/xlsx/docx viewers (pulled in by the sheet) stay
// out of this module's static import graph — the transcript is imported widely
// (hooks, etc.) and those consumers must not drag in @embedpdf's wasm at test
// time. The sheet mounts only when a document card is clicked.
const AttachmentViewerSheet = lazy(() =>
  import('@/components/attachment-viewer-sheet').then((m) => ({ default: m.AttachmentViewerSheet }))
)

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
  renderSegment: (seg: Segment, isLiveTail: boolean, nested?: boolean) => React.JSX.Element
}): React.JSX.Element {
  const running = task.status === 'running' || task.status === 'pending'
  const failed = task.status === 'failed' || task.status === 'cancelled'
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs">
      <button
        className="flex w-full items-center gap-2 text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Bot className={cn('size-3.5', running && 'animate-pulse text-primary')} />
        <span className="font-semibold uppercase tracking-wider">Subagent</span>
        {task.agentDefId && <span className="font-mono text-muted-foreground/60">· {task.agentDefId}</span>}
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Spinner className="size-3.5 text-primary" />
          ) : failed ? (
            <XCircleIcon className="size-3.5 text-red-600" />
          ) : (
            <CheckCircleIcon className="size-3.5 text-green-600" />
          )}
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <ScrollArea className="mt-3" viewportClassName="max-h-96">
          <div className="space-y-4">
            {groupSegments(segs).map((item) =>
              item.kind === 'single' ? (
                renderSegment(item.seg, item.seg.key === lastKey)
              ) : (
                <ToolGroupBlock key={item.segs[0].key} renderSegment={renderSegment} segs={item.segs} />
              )
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

// Collapsible block grouping several tool calls from one turn into a single row.
function ToolGroupBlock({
  segs,
  renderSegment,
}: {
  segs: Segment[]
  renderSegment: (seg: Segment, isLiveTail: boolean, nested?: boolean) => React.JSX.Element
}): React.JSX.Element {
  const running = segs.some((s) => s.kind === 'tool' && s.ok === null)
  const failed = segs.some((s) => s.kind === 'tool' && s.ok === false)
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const names = uniq(segs.map((s) => (s.kind === 'tool' ? s.tool : '')))

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
      {open && <div className="mt-3 space-y-4">{segs.map((seg) => renderSegment(seg, false, true))}</div>}
    </div>
  )
}

// Collapsible block for a single tool call. Mirrors the ToolGroupBlock chrome so
// a lone tool matches the Thinking / Tools rows instead of rendering as a
// mismatched bordered card. Reuses ToolInput/ToolOutput for the expanded body.
function SingleToolBlock({ seg }: { seg: Extract<Segment, { kind: 'tool' }> }): React.JSX.Element {
  const running = seg.ok === null
  const failed = seg.ok === false
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  const preview = seg.output ? seg.output.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs">
      <button
        className="flex w-full items-center gap-2 text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Wrench className={cn('size-3.5', running && 'animate-pulse text-primary')} />
        <span className="font-semibold uppercase tracking-wider">{seg.tool}</span>
        {preview && !open && <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{preview}</span>}
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Spinner className="size-3.5 text-primary" />
          ) : failed ? (
            <XCircleIcon className="size-3.5 text-red-600" />
          ) : (
            <CheckCircleIcon className="size-3.5 text-green-600" />
          )}
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <ToolInput input={seg.input} />
          {seg.imagePath && <ToolImage path={seg.imagePath} />}
          <ToolOutput
            errorText={seg.ok === false ? (seg.output ?? '') : undefined}
            output={seg.ok === false ? undefined : seg.output}
          />
        </div>
      )}
    </div>
  )
}

// Build the per-segment renderer. Closures (busy/onSend/onCopy/onDelete) are
// passed explicitly so both the live chat thread and the read-only results card
// share one rendering implementation. onDelete omitted → no Delete action.
//
// `nested` marks tool segments rendered INSIDE a ToolGroupBlock, where the old
// bordered Tool card is kept (a muted card nested in a muted card reads badly).
// Top-level single tools render as SingleToolBlock to match the Thinking row.
function createSegmentRenderer(opts: {
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (taskId: string) => void
  onOpenFile?: (file: ViewerFile) => void
}): (seg: Segment, isLiveTail: boolean, nested?: boolean) => React.JSX.Element {
  const { busy, onSend, onCopy, onDelete, onOpenFile } = opts

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

  const renderSegment = (seg: Segment, isLiveTail: boolean, nested = false): React.JSX.Element => {
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
              <Renderer disabled={busy} onOpenFile={onOpenFile} onSend={onSend} props={coerceProps(spec.props)} />
            </Message>
          )
        }
        // Unknown type → fall through to the generic Tool card below.
      }
      // Top-level single tool: render as a muted card matching the Thinking row.
      // Nested (inside a ToolGroupBlock) keeps the bordered Tool card below.
      if (!nested) {
        return <SingleToolBlock key={seg.key} seg={seg} />
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
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const ordered = sortBy(tasks, ['startedAt'])
  const renderSegment = createSegmentRenderer({
    busy,
    onCopy,
    onDelete,
    onOpenFile: setViewerFile,
    onSend,
  })

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

  let items: Array<{ ts: number; order: number; node: React.JSX.Element }> = []
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
  items = sortBy(items, ['ts', 'order'])

  if (!showDayDividers) {
    return (
      <>
        {items.map((it) => it.node)}
        {viewerFile && (
          <Suspense fallback={null}>
            <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
          </Suspense>
        )}
      </>
    )
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
  return (
    <>
      {out}
      {viewerFile && (
        <Suspense fallback={null}>
          <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
        </Suspense>
      )}
    </>
  )
}
