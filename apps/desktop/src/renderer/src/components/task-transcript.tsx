import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { uniq } from 'es-toolkit'
import {
  Bot,
  Brain,
  CheckCircleIcon,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  Timer,
  Trash2,
  Wrench,
  XCircleIcon,
} from 'lucide-react'
import { toast } from 'sonner'

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

import type { MessageRecord } from '@shared/lib/apply-event'
import { Button, Input, Popover, PopoverContent, Spinner } from '@swarm/ui'

import { coerceProps, getUiRenderer } from '@/components/ui-renderers'
import { swarmApi } from '@/lib/api'
import { buildTimelineItems, type TimelineItem } from '@/lib/build-timeline-items'
import { extractImagePaths } from '@/lib/file-paths'
import { groupSegments } from '@/lib/group-segments'
import type { Segment } from '@/lib/task-segments'
import { dayKey, formatDayLabel, formatMessageTime, safeTs } from '@/lib/timeline'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/stores/sessions'

// ToolHeader needs an AI-SDK-shaped tool type + state; derive both from our segment.
function toolState(ok: boolean | null): 'input-available' | 'output-available' | 'output-error' {
  if (ok === null) return 'input-available'
  return ok ? 'output-available' : 'output-error'
}

// Shared chrome for the collapsible transcript cards (Thinking / Tools / Subagent
// / event). A solid raised surface (bg-secondary) — not a near-transparent tint —
// so the card reads as distinct from the chat canvas it sits on.
const TRANSCRIPT_CARD =
  'rounded-xl border border-border/60 bg-secondary px-4 py-3 text-xs transition-colors hover:border-border'

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
    <div className={TRANSCRIPT_CARD}>
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

// Shared collapsible card for the transcript rows (Subagent / Tools / single
// Tool). Owns the open-while-running / auto-collapse-on-done state machine, the
// TRANSCRIPT_CARD chrome, the running/failed/done status badge, and a default
// max-height cap so long expanded bodies scroll instead of stretching the thread.
function TranscriptCard({
  icon,
  title,
  meta,
  elapsed,
  running = false,
  failed = false,
  maxHeight = 'max-h-96',
  children,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  /** Extra header content after the title (count, names, agent id, preview). */
  meta?: React.ReactNode | ((open: boolean) => React.ReactNode)
  /** Live or frozen elapsed timer shown before the status badge. */
  elapsed?: React.ReactNode
  running?: boolean
  failed?: boolean
  /** Viewport max-height class applied to the scrollable body; '' disables it. */
  maxHeight?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(running)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])

  return (
    <div className={TRANSCRIPT_CARD}>
      <button
        className="flex w-full items-center gap-2 text-muted-foreground/80 hover:text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {icon}
        <span className="font-semibold uppercase tracking-wider">{title}</span>
        {typeof meta === 'function' ? meta(open) : meta}
        <span className="ml-auto flex items-center gap-2">
          {elapsed}
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
      {open &&
        (maxHeight ? (
          <ScrollArea className="mt-3" viewportClassName={maxHeight}>
            <div className="space-y-3">{children}</div>
          </ScrollArea>
        ) : (
          <div className="mt-3 space-y-3">{children}</div>
        ))}
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
  task: MessageRecord
  segs: Segment[]
  lastKey: string | undefined
  renderSegment: (seg: Segment, isLiveTail: boolean, nested?: boolean) => React.JSX.Element
}): React.JSX.Element {
  const running = task.status === 'running' || task.status === 'pending'
  const failed = task.status === 'failed' || task.status === 'cancelled'

  return (
    <TranscriptCard
      elapsed={<ElapsedTimer createdAt={task.createdAt} endedAt={messageEndedAt(task)} />}
      failed={failed}
      icon={<Bot className={cn('size-3.5', running && 'animate-pulse text-primary')} />}
      meta={
        task.agentDefId ? <span className="font-mono text-muted-foreground/60">· {task.agentDefId}</span> : undefined
      }
      running={running}
      title="Subagent"
    >
      {groupSegments(segs).map((item) =>
        item.kind === 'single' ? (
          renderSegment(item.seg, item.seg.key === lastKey)
        ) : (
          <ToolGroupBlock key={item.segs[0].key} renderSegment={renderSegment} segs={item.segs} />
        )
      )}
    </TranscriptCard>
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
  const names = uniq(segs.map((s) => (s.kind === 'tool' ? s.tool : '')))
  const toolSegs = segs.filter((s): s is Extract<Segment, { kind: 'tool' }> => s.kind === 'tool')
  const startTs = toolSegs.length ? Math.min(...toolSegs.map((s) => s.ts)) : 0
  const endedTs = running
    ? null
    : toolSegs.every((s) => s.endedTs != null)
      ? Math.max(...toolSegs.map((s) => s.endedTs ?? 0))
      : null

  return (
    <TranscriptCard
      elapsed={<ElapsedTimer createdAt={startTs} endedAt={endedTs} />}
      failed={failed}
      icon={<Wrench className={cn('size-3.5', running && 'animate-pulse text-primary')} />}
      meta={
        <>
          <span className="text-muted-foreground/60">{segs.length}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/60">{names.join(', ')}</span>
        </>
      }
      running={running}
      title="Tools"
    >
      {segs.map((seg) => renderSegment(seg, false, true))}
    </TranscriptCard>
  )
}

// Collapsible block for a single tool call. Mirrors the ToolGroupBlock chrome so
// a lone tool matches the Thinking / Tools rows instead of rendering as a
// mismatched bordered card. Reuses ToolInput/ToolOutput for the expanded body.
function SingleToolBlock({ seg }: { seg: Extract<Segment, { kind: 'tool' }> }): React.JSX.Element {
  const running = seg.ok === null
  const failed = seg.ok === false
  const preview = seg.output ? seg.output.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined

  return (
    <TranscriptCard
      elapsed={<ElapsedTimer createdAt={seg.ts} endedAt={seg.endedTs ?? null} />}
      failed={failed}
      icon={<Wrench className={cn('size-3.5', running && 'animate-pulse text-primary')} />}
      meta={
        preview
          ? (open) => !open && <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{preview}</span>
          : undefined
      }
      running={running}
      title={seg.tool}
    >
      <ToolInput input={seg.input} />
      {seg.imagePath && <ToolImage path={seg.imagePath} />}
      <ToolOutput
        errorText={seg.ok === false ? (seg.output ?? '') : undefined}
        output={seg.ok === false ? undefined : seg.output}
      />
    </TranscriptCard>
  )
}

// Wall-clock end of a run's turn: the ts of its terminal (message.complete /
// message.error) event once the message reached a terminal status; null while the message is
// still in flight (pending / running / awaiting_user), which drives the live
// timer below to keep ticking.
function messageEndedAt(message: MessageRecord): number | null {
  const done = message.status === 'completed' || message.status === 'failed' || message.status === 'cancelled'
  if (!done) return null
  for (let i = message.events.length - 1; i >= 0; i--) {
    const ev = message.events[i]
    if (ev.kind === 'message.complete' || ev.kind === 'message.error') return ev.ts
  }
  return message.events[message.events.length - 1]?.ts ?? null
}

// Elapsed seconds, compact: "12s" under a minute, "2m 05s" beyond.
function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// Live elapsed counter shown above an assistant reply: counts up from 0 the
// moment the agent received the turn (message.createdAt) and freezes at the total
// once the turn completes (endedAt set). While running (endedAt null) it ticks
// once per second; the interval is torn down as soon as endedAt arrives.
function ElapsedTimer({ createdAt, endedAt }: { createdAt: number; endedAt: number | null }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endedAt != null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [endedAt])
  const end = endedAt ?? now
  const secs = Math.max(0, Math.floor((end - safeTs(createdAt)) / 1000))
  return (
    <span className="flex items-center gap-1 px-1 text-[10px] text-muted-foreground/50 tabular-nums">
      <Timer className="size-3" />
      {formatElapsed(secs)}
    </span>
  )
}

// Target of a "fork from here" action: the terminal assistant message whose
// turn the user wants to branch a new session from. Lifted into the segment
// renderer's opts so each terminal assistant row's hover button can open the
// shared ForkFromHereDialog (mirrors the AttachmentViewerSheet pattern).
type ForkTarget = {
  messageId: string
  sessionId: string
}

// Inline form that pops up when a user clicks "Fork from here" on a terminal
// assistant message. Calls swarmApi.forkSession then navigates to the new
// session. Rendered once at the timeline root (see useTimelineRenderer) and
// driven by a `target` prop instead of being mounted per-message, so the input
// state and pending spinner live in one place.
function ForkFromHereDialog({ target, onClose }: { target: ForkTarget; onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const markForked = useSessionsStore((s) => s.markForked)
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)

  const submit = async (): Promise<void> => {
    const trimmed = prompt.trim()
    if (!trimmed || pending) return
    setPending(true)
    try {
      const result = await swarmApi.forkSession(target.sessionId, target.messageId, trimmed)
      // Record the fork lineage client-side so the new session's header can
      // show a "forked from" badge. The backend's forkedFrom metadata is
      // in-memory only and not part of the sessions.list payload, so the
      // renderer owns this transient linkage.
      markForked(result.sessionId, target.sessionId)
      onClose()
      void navigate({ to: '/session/$sessionId', params: { sessionId: result.sessionId } })
    } catch (err) {
      setPending(false)
      toast.error('Fork failed', { description: err instanceof Error ? err.message : undefined })
    }
  }

  return (
    <Popover onOpenChange={(open) => !open && onClose()} open={true}>
      {/* No visible trigger; the action button that opens this lives in the
          message footer. The Popover is portalled + positioned at screen
          center via its content wrapper so it reads as a small centered card. */}
      <PopoverContent
        align="center"
        // Width + auto-margins center the portalled card horizontally on screen.
        className="mx-auto w-[min(92vw,32rem)]"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-foreground">
            <GitBranch className="size-4 text-primary" />
            <span className="font-medium text-sm">从这里分支</span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            从该消息处分叉出一个新会话,复制到此为止的上下文并以此处作为起点继续。
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Input
              autoFocus
              className="flex-1"
              disabled={pending}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入新指令…"
              value={prompt}
            />
            <Button disabled={pending || !prompt.trim()} size="sm" type="submit">
              {pending ? <Spinner className="size-3.5" /> : '分支'}
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
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
  tasks: MessageRecord[]
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (messageId: string) => void
  onOpenFile?: (file: ViewerFile) => void
  /** Open the "fork from here" dialog on a terminal assistant message. */
  onForkFromHere?: (target: ForkTarget) => void
}): (seg: Segment, isLiveTail: boolean, nested?: boolean) => React.JSX.Element {
  const { busy, tasks, onSend, onCopy, onDelete, onOpenFile, onForkFromHere } = opts
  const messageById = new Map(tasks.map((t) => [t.id, t]))

  // Time + copy/delete on one row: time always visible, actions revealed on
  // hover. User messages right-align the whole row. The optional fork action
  // (terminal assistant messages only) is appended when onForkFromHere is set.
  const messageFooter = (text: string, messageId: string, ts: number, message?: MessageRecord): React.JSX.Element => (
    <div className="flex items-center gap-2 px-1 group-[.is-user]:justify-end">
      <time className="text-[10px] text-muted-foreground/50 tabular-nums" dateTime={new Date(safeTs(ts)).toISOString()}>
        {formatMessageTime(ts)}
      </time>
      <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
        <MessageAction label="Copy" onClick={() => onCopy(text)} tooltip="Copy message">
          <Copy className="size-3.5" />
        </MessageAction>
        {onDelete && (
          <MessageAction label="Delete" onClick={() => onDelete(messageId)} tooltip="Delete message">
            <Trash2 className="size-3.5" />
          </MessageAction>
        )}
        {onForkFromHere && message && messageEndedAt(message) != null && (
          <MessageAction
            label="Fork from here"
            onClick={() => onForkFromHere({ messageId, sessionId: message.sessionId })}
            tooltip="从这里分支"
          >
            <GitBranch className="size-3.5" />
          </MessageAction>
        )}
      </MessageActions>
    </div>
  )

  const renderSegment = (seg: Segment, isLiveTail: boolean, nested = false): React.JSX.Element => {
    if (seg.kind === 'reasoning') {
      return <ReasoningBlock key={seg.key} live={isLiveTail && busy} text={seg.text} />
    }
    if (seg.kind === 'user') {
      return (
        <Message className="group" data-message-id={seg.messageId} from="user" key={seg.key}>
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
          {messageFooter(seg.text, seg.messageId, seg.ts, undefined)}
        </Message>
      )
    }
    if (seg.kind === 'assistant') {
      const images = extractImagePaths(seg.text)
      const message = messageById.get(seg.messageId)
      return (
        <Message className="group" data-message-id={seg.messageId} from="assistant" key={seg.key}>
          {message && <ElapsedTimer createdAt={message.createdAt} endedAt={messageEndedAt(message)} />}
          <MessageContent>
            <MessageResponse>{seg.text}</MessageResponse>
            {images.map((p) => (
              <ToolImage key={p} path={p} showName={false} />
            ))}
          </MessageContent>
          {messageFooter(seg.text, seg.messageId, seg.ts, message)}
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
      <details className={cn('group', TRANSCRIPT_CARD)} key={seg.key}>
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
  tasks: MessageRecord[]
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (messageId: string) => void
  showDayDividers?: boolean
}

// Shared renderer (createSegmentRenderer) + attachment-preview sheet + fork
// dialog. Used by both TaskTimeline (read-only results card) and the
// StickToBottomList-based chat thread so neither duplicates the viewerFile or
// fork wiring. `forkEnabled` (default true) gates the per-message hover button.
export function useTimelineRenderer(opts: {
  busy: boolean
  tasks: MessageRecord[]
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onDelete?: (messageId: string) => void
  forkEnabled?: boolean
}): {
  renderSegment: ReturnType<typeof createSegmentRenderer>
  sheet: React.JSX.Element | null
  forkDialog: React.JSX.Element | null
} {
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const [forkTarget, setForkTarget] = useState<ForkTarget | null>(null)
  const onForkFromHere = opts.forkEnabled === false ? undefined : setForkTarget
  const renderSegment = createSegmentRenderer({ ...opts, onOpenFile: setViewerFile, onForkFromHere })
  const sheet = viewerFile ? (
    <Suspense fallback={null}>
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </Suspense>
  ) : null
  const forkDialog = forkTarget ? <ForkFromHereDialog onClose={() => setForkTarget(null)} target={forkTarget} /> : null
  return { renderSegment, sheet, forkDialog }
}

// Wrap buildTimelineItems with the real card components (SubagentBlock /
// ToolGroupBlock / DayDivider) so both TaskTimeline and the chat thread share
// one render path. `renderSegment` comes from useTimelineRenderer.
export function buildThreadItems(
  tasks: MessageRecord[],
  renderSegment: ReturnType<typeof createSegmentRenderer>,
  opts: { busy: boolean; showDayDividers?: boolean }
): TimelineItem[] {
  return buildTimelineItems(
    tasks,
    {
      segment: renderSegment,
      subagent: (t, segs, lastKey) => (
        <SubagentBlock key={t.id} lastKey={lastKey} renderSegment={renderSegment} segs={segs} task={t} />
      ),
      toolGroup: (segs) => <ToolGroupBlock key={segs[0].key} renderSegment={renderSegment} segs={segs} />,
      dayDivider: (ts) => <DayDivider key={`day-${dayKey(ts)}`} ts={ts} />,
    },
    opts
  )
}

// Render a set of tasks' segments interleaved in true causal order (by seq): a
// top-level task contributes its segments individually, a spawned sub-agent
// contributes ONE grouped block at its spawn point. Optional day dividers spine
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
  const { renderSegment, sheet, forkDialog } = useTimelineRenderer({ busy, onCopy, onDelete, onSend, tasks })
  const items = buildThreadItems(tasks, renderSegment, { busy, showDayDividers })
  return (
    <>
      {items.map((it) => it.node)}
      {sheet}
      {forkDialog}
    </>
  )
}

// Day divider row spliced between timeline items when the day changes. Extracted
// from TaskTimeline so buildTimelineItems can stay pure (no JSX) and receive it
// as a render callback.
function DayDivider({ ts }: { ts: number }): React.JSX.Element {
  const now = Date.now()
  return (
    <div className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground/60">
      <div className="h-px flex-1 bg-border/40" />
      <span className="font-medium uppercase tracking-wide">{formatDayLabel(ts, now)}</span>
      <div className="h-px flex-1 bg-border/40" />
    </div>
  )
}
