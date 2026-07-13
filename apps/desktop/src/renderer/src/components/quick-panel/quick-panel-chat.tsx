// Chat mode mini-session. On first Enter: creates a session + submits the
// prompt. Subsequent Enter appends to the same session. Streaming is driven by
// the shared MESSAGES_KEY query cache (updated by EventsBridge's swarm:event
// subscription). Esc closes the panel.
//
// Text extraction: MessageRecord has no content/role fields. We reuse
// taskSegments() (the same pure function the main thread uses) to extract
// user/assistant text segments from task.events[]. Only user + assistant
// segments are rendered; tool/reasoning/error segments are skipped for the
// mini view.
import { useEffect, useMemo, useRef, useState } from 'react'

import { useMessages } from '@/hooks/use-messages'
import { swarmApi } from '@/lib/api'
import { taskSegments } from '@/lib/task-segments'
import { useSessionsStore } from '@/stores/sessions'

const DEFAULT_FORMATION = 'ceo'

// Statuses where the agent is actively producing output.
const STREAMING_STATUSES = new Set(['running', 'pending', 'awaiting_user'])

type Bubble = {
  key: string
  role: 'user' | 'assistant'
  text: string
}

export function QuickPanelChat(): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const allMessages = useMessages()
  const selectSession = useSessionsStore((s) => s.select)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Focus the input on mount so typing flows straight in. The panel window
  // mounts fresh each time it's shown, so a mount effect is enough; we avoid
  // the `autoFocus` attr (biome a11y/noAutofocus) — same pattern as
  // quick-panel-input.
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Filter + sort messages to the panel's session (by task.order for correct
  // turn sequence, same as conversation-thread.tsx).
  const tasks = useMemo(
    () => (sessionId ? allMessages.filter((m) => m.sessionId === sessionId) : []).sort((a, b) => a.order - b.order),
    [allMessages, sessionId]
  )

  // Flatten tasks into user/assistant text bubbles via taskSegments.
  const bubbles = useMemo<Bubble[]>(() => {
    const out: Bubble[] = []
    for (const task of tasks) {
      for (const seg of taskSegments(task)) {
        if (seg.kind === 'user' || seg.kind === 'assistant') {
          out.push({ key: seg.key, role: seg.kind, text: seg.text })
        }
      }
    }
    return out
  }, [tasks])

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [bubbles])

  // Detect when streaming ends (last task is no longer in a streaming status).
  useEffect(() => {
    const last = tasks[tasks.length - 1]
    if (last && STREAMING_STATUSES.has(last.status)) {
      setIsStreaming(true)
    } else {
      setIsStreaming(false)
    }
  }, [tasks])

  // Resize the panel to fit content (grows with bubbles, capped at 480 by main).
  useEffect(() => {
    const height = Math.min(96 + bubbles.length * 60, 480)
    void swarmApi.quickPanelResize(height)
  }, [bubbles.length])

  const handleSubmit = async (): Promise<void> => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    let sid = sessionId
    if (!sid) {
      const created = await swarmApi.createSession()
      sid = created.sessionId
      setSessionId(sid)
      selectSession(sid)
    }

    setInput('')
    setIsStreaming(true)
    await swarmApi.submitPrompt(sid, trimmed, undefined, { agentType: DEFAULT_FORMATION })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void swarmApi.quickPanelHide()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-popover/82 backdrop-blur-[40px]">
      {/* Message list */}
      <div className="cmdscroll min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={scrollRef}>
        {bubbles.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">输入消息开始对话…</div>
        )}
        {bubbles.map((b) => (
          <div className="mb-3" key={b.key}>
            <div className="mb-0.5 text-muted-foreground text-xs">{b.role === 'user' ? '你' : 'Agent'}</div>
            <div
              className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${b.role === 'user' ? 'bg-primary/10' : 'bg-muted/40'}`}
            >
              {b.text || (isStreaming && b.role === 'assistant' ? '…' : '')}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-border/60 border-t px-4 py-3">
        <input
          className="bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
          disabled={isStreaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isStreaming ? 'Agent 正在回复…' : '输入消息,Enter 发送,Esc 关闭…'}
          ref={inputRef}
          value={input}
        />
      </div>
    </div>
  )
}
