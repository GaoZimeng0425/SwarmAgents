import { useEffect, useRef } from 'react'
import type { TaskEvent } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'
import { ChevronRight, MessagesSquare } from 'lucide-react'

import { Markdown } from '@/components/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import type { TaskRecord } from '@/lib/apply-event'
import { formatUsage } from '@/lib/format-usage'
import { cn } from '@/lib/utils'

type Bubble =
  | { kind: 'user'; text: string; key: string }
  | { kind: 'assistant'; text: string; key: string }
  | { kind: 'event'; label: string; detail: string; key: string }

function toolDetail(ev: Extract<TaskEvent, { kind: 'tool.result' }>): string {
  const p = ev.payload as { text?: string } | undefined
  return typeof p?.text === 'string' ? p.text : JSON.stringify(ev.payload ?? {}, null, 2)
}

/** Flatten a task's UIEvents into ordered chat bubbles. */
function bubblesFor(task: TaskRecord): Bubble[] {
  const out: Bubble[] = [{ kind: 'user', text: task.goal, key: `${task.id}-goal` }]

  // The service streams assistant text as a sequence of delta events (flushed at
  // sentence boundaries). Coalesce consecutive assistant events into one growing
  // bubble so streaming reads as a single message, Codex-style.
  const pushAssistant = (text: string, key: string): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key })
  }

  // The update_plan tool is rendered as the dedicated PlanPanel, so its call and
  // result are suppressed from the transcript.
  let skipNextToolResult = false
  task.events.forEach((e: UIEvent, i) => {
    const key = `${task.id}-${i}`
    if (e.kind === 'task.progress') {
      const ev = e.event
      // user/tool-role messages are internal context, not shown as chat bubbles
      if (ev.kind === 'llm.message' && ev.role === 'assistant') {
        pushAssistant(typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content), key)
      } else if (ev.kind === 'tool.call') {
        if (ev.tool === 'update_plan') {
          skipNextToolResult = true
          return
        }
        out.push({ kind: 'event', label: `tool · ${ev.tool}`, detail: JSON.stringify(ev.args ?? {}, null, 2), key })
      } else if (ev.kind === 'tool.result') {
        if (skipNextToolResult) {
          skipNextToolResult = false
          return
        }
        out.push({ kind: 'event', label: ev.ok ? 'tool result' : 'tool error', detail: toolDetail(ev), key })
      } else if (ev.kind === 'error') {
        out.push({ kind: 'event', label: 'error', detail: ev.error.message ?? 'error', key })
      }
    } else if (e.kind === 'task.permission_request') {
      out.push({ kind: 'event', label: `permission (${e.risk})`, detail: e.summary, key })
    } else if (e.kind === 'task.error') {
      const msg =
        typeof e.error === 'object' && e.error && 'message' in e.error
          ? String((e.error as { message: unknown }).message)
          : 'error'
      out.push({ kind: 'event', label: 'error', detail: msg, key })
    }
  })
  return out
}

type Props = { tasks: TaskRecord[] }

export function ConversationThread({ tasks }: Props): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)
  // Stick to the bottom as new bubbles arrive. Instant (block: 'end' / 'auto'),
  // not smooth — 03 § C.4: smooth-scroll polyfills feel web-y, not native.
  const tail = ordered.map((t) => `${t.id}:${t.events.length}:${t.status}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tail` is a change-signal — re-scroll whenever the thread grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [tail])

  if (tasks.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessagesSquare aria-hidden="true" className="size-6 opacity-60" />
        <p className="text-sm">Send a message to start the conversation.</p>
      </div>
    )
  }

  const last = ordered[ordered.length - 1]
  const busy = last.status === 'running' || last.status === 'pending'
  const usage = last.used

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
        {ordered.flatMap((t) =>
          bubblesFor(t).map((b) => {
            if (b.kind === 'user') {
              return (
                <div className="flex justify-end" key={b.key}>
                  <div className="user-content max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground text-sm">
                    {b.text}
                  </div>
                </div>
              )
            }
            if (b.kind === 'assistant') {
              return (
                <div className="user-content max-w-none" key={b.key}>
                  <Markdown>{b.text}</Markdown>
                </div>
              )
            }
            return (
              <details
                className={cn(
                  'group rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs transition-colors hover:bg-muted/50'
                )}
                key={b.key}
              >
                <summary className="flex select-none items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                  <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                  {b.label}
                </summary>
                <pre className="user-content mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground leading-relaxed">
                  {b.detail}
                </pre>
              </details>
            )
          })
        )}
        {busy && (
          <div className="flex items-center gap-2 px-1 text-muted-foreground text-sm">
            <Spinner className="size-3.5" />
            <span>{last.status === 'pending' ? 'Queued…' : 'Working…'}</span>
            {usage && <span className="text-xs opacity-70">· {formatUsage(usage)}</span>}
          </div>
        )}
        {!busy && usage && <div className="px-1 text-muted-foreground text-xs opacity-70">{formatUsage(usage)}</div>}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
