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
