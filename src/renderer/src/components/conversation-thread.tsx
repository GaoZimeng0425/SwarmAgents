import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Copy, MessagesSquare, Trash2 } from 'lucide-react'
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
import { Spinner } from '@/components/ui/spinner'
import { TASKS_KEY } from '@/hooks/use-tasks'
import type { TaskRecord } from '@/lib/apply-event'
import { formatUsage } from '@/lib/format-usage'
import { type Segment, taskSegments } from '@/lib/task-segments'

type Props = { tasks: TaskRecord[] }

// ToolHeader needs an AI-SDK-shaped tool type + state; derive both from our segment.
function toolState(ok: boolean | null): 'input-available' | 'output-available' | 'output-error' {
  if (ok === null) return 'input-available'
  return ok ? 'output-available' : 'output-error'
}

export function ConversationThread({ tasks }: Props): React.JSX.Element {
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
    <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
      <MessageAction label="Copy" onClick={() => onCopy(text)} tooltip="Copy message">
        <Copy className="size-3.5" />
      </MessageAction>
      <MessageAction label="Delete" onClick={() => onDelete(taskId)} tooltip="Delete message">
        <Trash2 className="size-3.5" />
      </MessageAction>
    </MessageActions>
  )

  const renderSegment = (seg: Segment): React.JSX.Element => {
    if (seg.kind === 'user') {
      return (
        <Message className="group" from="user" key={seg.key}>
          <MessageContent>
            <span className="whitespace-pre-wrap">{seg.text}</span>
          </MessageContent>
          {messageActions(seg.text, seg.taskId)}
        </Message>
      )
    }
    if (seg.kind === 'assistant') {
      return (
        <Message className="group" from="assistant" key={seg.key}>
          <MessageContent>
            <MessageResponse>{seg.text}</MessageResponse>
          </MessageContent>
          {messageActions(seg.text, seg.taskId)}
        </Message>
      )
    }
    if (seg.kind === 'tool') {
      return (
        <Tool key={seg.key}>
          <ToolHeader state={toolState(seg.ok)} title={seg.tool} type={`tool-${seg.tool}` as `tool-${string}`} />
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
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/50 p-3 font-mono text-[11px] text-muted-foreground leading-relaxed ring-1 ring-border/30">
          {seg.detail}
        </pre>
      </details>
    )
  }

  return (
    <Conversation className="flex-1">
      <ConversationContent className="mx-auto max-w-3xl">
        {ordered.flatMap((t) => taskSegments(t).map(renderSegment))}
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
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
