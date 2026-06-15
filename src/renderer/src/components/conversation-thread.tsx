import { useEffect, useRef } from 'react'
import type { TaskEvent } from '@shared/types/task'
import type { UIEvent } from '@shared/types/ui'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Copy, MessagesSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Markdown } from '@/components/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { TASKS_KEY } from '@/hooks/use-tasks'
import type { TaskRecord } from '@/lib/apply-event'
import { formatUsage } from '@/lib/format-usage'
import { cn } from '@/lib/utils'

type Bubble =
  | { kind: 'user'; text: string; key: string; taskId: string }
  | { kind: 'assistant'; text: string; key: string; taskId: string }
  | { kind: 'event'; label: string; detail: string; key: string; taskId: string }

function toolDetail(ev: Extract<TaskEvent, { kind: 'tool.result' }>): string {
  const p = ev.payload as { text?: string } | undefined
  return typeof p?.text === 'string' ? p.text : JSON.stringify(ev.payload ?? {}, null, 2)
}

/** Flatten a task's UIEvents into ordered chat bubbles. */
function bubblesFor(task: TaskRecord): Bubble[] {
  const out: Bubble[] = [{ kind: 'user', text: task.goal, key: `${task.id}-goal`, taskId: task.id }]

  // The service streams assistant text as a sequence of delta events (flushed at
  // sentence boundaries). Coalesce consecutive assistant events into one growing
  // bubble so streaming reads as a single message, Codex-style.
  const pushAssistant = (text: string, key: string): void => {
    const last = out[out.length - 1]
    if (last && last.kind === 'assistant') last.text += text
    else out.push({ kind: 'assistant', text, key, taskId: task.id })
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
        out.push({
          kind: 'event',
          label: `tool · ${ev.tool}`,
          detail: JSON.stringify(ev.args ?? {}, null, 2),
          key,
          taskId: task.id,
        })
      } else if (ev.kind === 'tool.result') {
        if (skipNextToolResult) {
          skipNextToolResult = false
          return
        }
        out.push({
          kind: 'event',
          label: ev.ok ? 'tool result' : 'tool error',
          detail: toolDetail(ev),
          key,
          taskId: task.id,
        })
      } else if (ev.kind === 'error') {
        out.push({ kind: 'event', label: 'error', detail: ev.error.message ?? 'error', key, taskId: task.id })
      }
    } else if (e.kind === 'task.permission_request') {
      out.push({ kind: 'event', label: `permission (${e.risk})`, detail: e.summary, key, taskId: task.id })
    } else if (e.kind === 'task.error') {
      const err = typeof e.error === 'object' && e.error ? (e.error as { message?: unknown; code?: unknown }) : null
      const msg = err && 'message' in err ? String(err.message) : 'error'
      const label = err?.code === 'cancelled' ? 'stopped' : 'error'
      out.push({ kind: 'event', label, detail: msg, key, taskId: task.id })
    }
  })
  return out
}

type Props = { tasks: TaskRecord[] }

export function ConversationThread({ tasks }: Props): React.JSX.Element {
  const qc = useQueryClient()
  const bottomRef = useRef<HTMLDivElement>(null)

  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)
  // Stick to the bottom as new bubbles arrive. Instant (block: 'end' / 'auto'),
  // not smooth — 03 § C.4: smooth-scroll polyfills feel web-y, not native.
  const tail = ordered.map((t) => `${t.id}:${t.events.length}:${t.status}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tail` is a change-signal — re-scroll whenever the thread grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [tail])

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
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10">
        {ordered.flatMap((t) =>
          bubblesFor(t).map((b) => {
            if (b.kind === 'user') {
              return (
                <div className="group flex justify-end" key={b.key}>
                  <div className="relative flex flex-col items-end gap-1">
                    <div className="user-content max-w-[92%] whitespace-pre-wrap rounded-[20px] rounded-tr-sm bg-primary px-4 py-2.5 text-[15px] text-primary-foreground shadow-sm transition-all hover:shadow-md">
                      {b.text}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className="p-1 text-muted-foreground/60 transition-colors hover:text-primary"
                        onClick={() => onCopy(b.text)}
                        title="Copy message"
                        type="button"
                      >
                        <Copy className="size-3.5" />
                      </button>
                      <button
                        className="p-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                        onClick={() => onDelete(b.taskId)}
                        title="Delete message"
                        type="button"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )
            }
            if (b.kind === 'assistant') {
              return (
                <div className="group flex justify-start" key={b.key}>
                  <div className="relative flex flex-col items-start gap-1">
                    <div className="user-content max-w-[92%] rounded-[22px] rounded-tl-sm border border-border/40 bg-card/60 px-6 py-4 text-[15px] leading-relaxed shadow-sm backdrop-blur-sm transition-all hover:border-border/80 hover:shadow-md">
                      <Markdown>{b.text}</Markdown>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className="p-1 text-muted-foreground/60 transition-colors hover:text-primary"
                        onClick={() => onCopy(b.text)}
                        title="Copy message"
                        type="button"
                      >
                        <Copy className="size-3.5" />
                      </button>
                      <button
                        className="p-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                        onClick={() => onDelete(b.taskId)}
                        title="Delete message"
                        type="button"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )
            }
            return (
              <details
                className={cn(
                  'group rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-xs transition-all hover:border-border hover:bg-muted/40'
                )}
                key={b.key}
              >
                <summary className="flex cursor-pointer select-none items-center gap-2 font-mono text-[11px] text-muted-foreground/80 hover:text-muted-foreground">
                  <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" />
                  <span className="font-semibold uppercase tracking-wider">{b.label}</span>
                </summary>
                <div className="user-content mt-3 overflow-hidden rounded-lg bg-background/50 p-3 ring-1 ring-border/30">
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground leading-relaxed">
                    {b.detail}
                  </pre>
                </div>
              </details>
            )
          })
        )}
        {busy && (
          <div className="flex animate-pulse items-center gap-3 px-1 text-muted-foreground text-sm">
            <Spinner className="size-4 text-primary" />
            <span className="font-medium">{last.status === 'pending' ? 'Queued…' : 'Swarm is thinking…'}</span>
            {usage && <span className="text-xs opacity-60">· {formatUsage(usage)}</span>}
          </div>
        )}
        {!busy && usage && (
          <div className="flex items-center gap-2 border-border/30 border-t px-1 pt-4 text-muted-foreground text-xs opacity-60">
            <div className="size-1 rounded-full bg-border" />
            {formatUsage(usage)}
          </div>
        )}
        <div className="h-4" ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
