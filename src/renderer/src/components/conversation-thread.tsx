import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Bot, Brain, ChevronRight, Copy, ExternalLink, MessagesSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { coerceProps, getUiRenderer } from '@/components/ui-renderers'
import { TASKS_KEY } from '@/hooks/use-tasks'
import type { TaskRecord } from '@/lib/apply-event'
import { extractImagePaths } from '@/lib/file-paths'
import { formatUsage, usageTooltip } from '@/lib/format-usage'
import { type Segment, taskSegments } from '@/lib/task-segments'
import { cn } from '@/lib/utils'

type Props = {
  tasks: TaskRecord[]
  /** Start a new user turn with the given text (used by interactive UI cards). */
  onSend?: (text: string) => void
}

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
// sub-agent runs (so its progress is visible), shows a spinner on the right,
// then auto-collapses once it finishes — matching the ReasoningBlock idiom.
// The user can still toggle it via the chevron.
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

export function ConversationThread({ tasks, onSend }: Props): React.JSX.Element {
  const qc = useQueryClient()
  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)

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
  const usage = last.used

  const messageActions = (text: string, taskId: string): React.JSX.Element => (
    <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 group-[.is-user]:justify-end">
      <MessageAction label="Copy" onClick={() => onCopy(text)} tooltip="Copy message">
        <Copy className="size-3.5" />
      </MessageAction>
      <MessageAction label="Delete" onClick={() => onDelete(taskId)} tooltip="Delete message">
        <Trash2 className="size-3.5" />
      </MessageAction>
    </MessageActions>
  )

  const renderSegment = (seg: Segment, isLiveTail: boolean): React.JSX.Element => {
    if (seg.kind === 'reasoning') {
      return <ReasoningBlock key={seg.key} live={isLiveTail && busy} text={seg.text} />
    }
    if (seg.kind === 'user') {
      return (
        <Message className="group" from="user" key={seg.key}>
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
          {messageActions(seg.text, seg.taskId)}
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

  return (
    <Conversation className="flex-1">
      {/* user-content re-enables text selection (globals.css disables it on chrome by default). */}
      <ConversationContent className="user-content mx-auto max-w-3xl">
        {(() => {
          // Interleave segments across tasks in true causal order: a top-level
          // task contributes its segments individually (sorted by their own ts),
          // while a spawned sub-agent contributes ONE grouped block positioned at
          // its spawn time (startedAt). This keeps a sub-agent's block at the
          // point it was spawned and the parent's final reply after it — instead
          // of dumping whole child tasks below the parent. isLiveTail is the
          // chronologically last segment, so live streaming styling stays correct.
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
              for (const seg of segs) {
                items.push({ ts: seg.ts, order: order++, node: renderSegment(seg, seg.key === lastKey) })
              }
            }
          }
          items.sort((a, b) => a.ts - b.ts || a.order - b.order)
          return items.map((it) => it.node)
        })()}
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
