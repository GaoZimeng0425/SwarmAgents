import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { uniq } from 'es-toolkit'
import { Bot, Brain, CheckCircleIcon, ChevronRight, Copy, ExternalLink, Wrench, XCircleIcon } from 'lucide-react'

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
// and those consumers must not drag in @embedpdf's wasm at test time.
const AttachmentViewerSheet = lazy(() =>
  import('@/components/attachment-viewer-sheet').then((m) => ({ default: m.AttachmentViewerSheet }))
)

import type { Segment } from '@swarm/shared'
import { Spinner } from '@swarm/ui'

import { coerceProps, getUiRenderer } from '@/components/ui-renderers'
import { useSessionView } from '@/hooks/use-session-view'
import { extractImagePaths } from '@/lib/file-paths'
import { groupSegments } from '@/lib/group-segments'
import { dayKey, formatDayLabel, formatMessageTime, safeTs } from '@/lib/timeline'
import { cn } from '@/lib/utils'

// One row in the rendered thread; the virtualized list keys + orders on these.
export type TimelineItem = { key: string; node: React.ReactNode; order: number; ts: number }

type ToolSeg = Extract<Segment, { kind: 'tool' }>
type EventSeg = Extract<Segment, { kind: 'event' }>

// ToolHeader needs an AI-SDK-shaped tool type + state; derive both from our segment.
function toolState(ok: boolean | null): 'input-available' | 'output-available' | 'output-error' {
  if (ok === null) return 'input-available'
  return ok ? 'output-available' : 'output-error'
}

// Shared chrome for the collapsible transcript cards (Thinking / Tools / Subagent).
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

// Shared collapsible card (Subagent / Tools / single Tool). Owns the
// open-while-running / auto-collapse-on-done state machine, the card chrome, the
// running/failed/done badge, and a scrollable body cap.
function TranscriptCard({
  icon,
  title,
  meta,
  running = false,
  failed = false,
  maxHeight = 'max-h-96',
  children,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode | ((open: boolean) => React.ReactNode)
  running?: boolean
  failed?: boolean
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

// Collapsible block grouping one spawned sub-agent's own session view. Lazily
// loads the child session (useSessionView) and renders its flattened segments.
// Open + spinner while the child run is in flight, auto-collapses when it ends.
function SubagentBlock({
  childSessionId,
  agentDefId,
  renderSegment,
}: {
  childSessionId: string
  agentDefId?: string
  renderSegment: SegmentRenderer
}): React.JSX.Element {
  const { view, segments } = useSessionView(childSessionId)
  const running = view.running
  const failed = !!view.lastError

  return (
    <TranscriptCard
      failed={failed}
      icon={<Bot className={cn('size-3.5', running && 'animate-pulse text-primary')} />}
      meta={agentDefId ? <span className="font-mono text-muted-foreground/60">· {agentDefId}</span> : undefined}
      running={running}
      title="Subagent"
    >
      {groupSegments(segments).map((item) =>
        item.kind === 'single' ? (
          renderSegment(item.seg, false)
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
  renderSegment: SegmentRenderer
}): React.JSX.Element {
  const running = segs.some((s) => s.kind === 'tool' && s.ok === null)
  const failed = segs.some((s) => s.kind === 'tool' && s.ok === false)
  const names = uniq(segs.map((s) => (s.kind === 'tool' ? s.tool : '')))

  return (
    <TranscriptCard
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

// Collapsible block for a single top-level tool call. Mirrors ToolGroupBlock
// chrome so a lone tool matches the Thinking / Tools rows.
function SingleToolBlock({ seg }: { seg: ToolSeg }): React.JSX.Element {
  const running = seg.ok === null
  const failed = seg.ok === false
  const preview = seg.output ? seg.output.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined

  return (
    <TranscriptCard
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
      <ToolOutput
        errorText={seg.ok === false ? (seg.output ?? '') : undefined}
        output={seg.ok === false ? undefined : seg.output}
      />
    </TranscriptCard>
  )
}

export type SegmentRenderer = (seg: Segment, isLiveTail: boolean, nested?: boolean) => React.JSX.Element

// Build the per-segment renderer. Closures (busy/onSend/onCopy) are passed
// explicitly so both the live chat thread and read-only results cards share one
// rendering implementation.
//
// `nested` marks tool segments rendered INSIDE a ToolGroupBlock, where the
// bordered Tool card is kept; top-level single tools render as SingleToolBlock.
function createSegmentRenderer(opts: {
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  onOpenFile?: (file: ViewerFile) => void
}): SegmentRenderer {
  const { busy, onSend, onCopy, onOpenFile } = opts

  const messageFooter = (text: string, ts: number): React.JSX.Element => (
    <div className="flex items-center gap-2 px-1 group-[.is-user]:justify-end">
      <time className="text-[10px] text-muted-foreground/50 tabular-nums" dateTime={new Date(safeTs(ts)).toISOString()}>
        {formatMessageTime(ts)}
      </time>
      <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
        <MessageAction label="Copy" onClick={() => onCopy(text)} tooltip="Copy message">
          <Copy className="size-3.5" />
        </MessageAction>
      </MessageActions>
    </div>
  )

  const renderSegment: SegmentRenderer = (seg, isLiveTail, nested = false) => {
    if (seg.kind === 'reasoning') {
      return <ReasoningBlock key={seg.key} live={isLiveTail && busy} text={seg.text} />
    }
    if (seg.kind === 'user') {
      return (
        <Message className="group" from="user" key={seg.key}>
          <MessageContent>
            <span className="whitespace-pre-wrap">{seg.text}</span>
          </MessageContent>
          {messageFooter(seg.text, seg.ts)}
        </Message>
      )
    }
    if (seg.kind === 'assistant') {
      const images = extractImagePaths(seg.text)
      return (
        <Message className="group" from="assistant" key={seg.key}>
          <MessageContent>
            <MessageResponse>{seg.text}</MessageResponse>
            {images.map((p) => (
              <ToolImage key={p} path={p} showName={false} />
            ))}
          </MessageContent>
          {messageFooter(seg.text, seg.ts)}
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
            <ToolOutput
              errorText={seg.ok === false ? (seg.output ?? '') : undefined}
              output={seg.ok === false ? undefined : seg.output}
            />
          </ToolContent>
        </Tool>
      )
    }
    // 'event' with a childSessionId is a spawned sub-agent → nested view block.
    if (seg.kind === 'event' && (seg as EventSeg).childSessionId) {
      const ev = seg as EventSeg
      return (
        <SubagentBlock
          agentDefId={ev.agentDefId}
          childSessionId={ev.childSessionId as string}
          key={seg.key}
          renderSegment={renderSegment}
        />
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

// Shared renderer + attachment-preview sheet. Used by both TaskTimeline
// (read-only results card) and the StickToBottomList-based chat thread.
export function useTimelineRenderer(opts: {
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
}): { renderSegment: SegmentRenderer; sheet: React.JSX.Element | null } {
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const renderSegment = createSegmentRenderer({ ...opts, onOpenFile: setViewerFile })
  const sheet = viewerFile ? (
    <Suspense fallback={null}>
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </Suspense>
  ) : null
  return { renderSegment, sheet }
}

// Turn a flat Segment[] into keyed timeline rows: consecutive tool segments
// collapse into one ToolGroupBlock; optional day dividers spine the thread when
// the calendar day changes between segments.
export function buildThreadItems(
  segments: Segment[],
  renderSegment: SegmentRenderer,
  opts: { showDayDividers?: boolean } = {}
): TimelineItem[] {
  const { showDayDividers = false } = opts
  const items: TimelineItem[] = []
  let lastDay: string | null = null
  let order = 0

  for (const item of groupSegments(segments)) {
    const seg = item.kind === 'single' ? item.seg : item.segs[0]
    if (showDayDividers) {
      const day = dayKey(seg.ts)
      if (day !== lastDay) {
        lastDay = day
        items.push({ key: `day-${day}`, node: <DayDivider ts={seg.ts} />, order: order++, ts: seg.ts })
      }
    }
    const node =
      item.kind === 'single' ? (
        renderSegment(item.seg, false)
      ) : (
        <ToolGroupBlock key={item.segs[0].key} renderSegment={renderSegment} segs={item.segs} />
      )
    items.push({ key: seg.key, node, order: order++, ts: seg.ts })
  }
  return items
}

// Render a flat Segment[] inline (read-only results card, no virtualization).
export function TaskTimeline({
  segments,
  busy,
  onSend,
  onCopy,
  showDayDividers = false,
}: {
  segments: Segment[]
  busy: boolean
  onSend?: (text: string) => void
  onCopy: (text: string) => void
  showDayDividers?: boolean
}): React.JSX.Element {
  const { renderSegment, sheet } = useTimelineRenderer({ busy, onCopy, onSend })
  const items = buildThreadItems(segments, renderSegment, { showDayDividers })
  return (
    <>
      {items.map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
      {sheet}
    </>
  )
}

// Day divider row spliced between timeline items when the day changes.
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
