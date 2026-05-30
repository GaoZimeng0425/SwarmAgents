import type { UIEvent } from '@shared/types/ui'
import type { TaskEvent } from '@shared/types/task'

import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { TaskRecord } from '@/lib/apply-event'

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
  task.events.forEach((e: UIEvent, i) => {
    const key = `${task.id}-${i}`
    if (e.kind === 'task.progress') {
      const ev = e.event
      if (ev.kind === 'llm.message' && ev.role === 'assistant') {
        out.push({
          kind: 'assistant',
          text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          key,
        })
      } else if (ev.kind === 'tool.call') {
        out.push({ kind: 'event', label: `tool · ${ev.tool}`, detail: JSON.stringify(ev.args ?? {}, null, 2), key })
      } else if (ev.kind === 'tool.result') {
        out.push({ kind: 'event', label: ev.ok ? 'tool result' : 'tool error', detail: toolDetail(ev), key })
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
  if (tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Send a message to start the conversation.
      </div>
    )
  }

  const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        {ordered.flatMap((t) =>
          bubblesFor(t).map((b) => {
            if (b.kind === 'user') {
              return (
                <div className="flex justify-end" key={b.key}>
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-primary-foreground text-sm">
                    {b.text}
                  </div>
                </div>
              )
            }
            if (b.kind === 'assistant') {
              return (
                <div className="flex justify-start" key={b.key}>
                  <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-4 py-2 text-sm">
                    {b.text}
                  </div>
                </div>
              )
            }
            return (
              <details className={cn('rounded-lg border bg-background/50 px-3 py-1.5 text-xs')} key={b.key}>
                <summary className="cursor-pointer select-none text-muted-foreground">{b.label}</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed">
                  {b.detail}
                </pre>
              </details>
            )
          }),
        )}
        <div className="flex justify-center pt-1">
          <Badge variant="outline">{ordered[ordered.length - 1].status}</Badge>
        </div>
      </div>
    </ScrollArea>
  )
}
