// Chat mode mini-session. On first Enter: creates a session + submits the
// prompt. Subsequent Enter appends to the same session. Streaming is driven by
// the session's SessionView (folded from live wire events + catch-up load).
// Esc closes the panel; Backspace on empty input returns to palette mode.
//
// Text extraction: buildSegments (via useSessionView) flattens the session's
// entries into render segments; only user + assistant segments are rendered for
// the mini view. Rendering reuses the same Message components as the main
// conversation thread for visual consistency.
import { useEffect, useMemo, useRef, useState } from 'react'

import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { useSessionView } from '@/hooks/use-session-view'
import { swarmApi } from '@/lib/api'
import { useSessionsStore } from '@/stores/sessions'

const DEFAULT_FORMATION = 'ceo'

type Bubble = {
  key: string
  role: 'user' | 'assistant'
  text: string
}

export function QuickPanelChat({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const { view, segments } = useSessionView(sessionId)
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

  // The run is in flight while the view reports running, or optimistically
  // between submit and the first agent_start.
  const isStreaming = view.running || pending

  // Flatten segments into user/assistant text bubbles.
  const bubbles = useMemo<Bubble[]>(() => {
    const out: Bubble[] = []
    for (const seg of segments) {
      if (seg.kind === 'user' || seg.kind === 'assistant') {
        out.push({ key: seg.key, role: seg.kind, text: seg.text })
      }
    }
    return out
  }, [segments])

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [bubbles])

  // Clear the optimistic pending flag once the run actually starts.
  useEffect(() => {
    if (view.running) setPending(false)
  }, [view.running])

  const handleSubmit = async (): Promise<void> => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    let sid = sessionId
    if (!sid) {
      try {
        const created = await swarmApi.createSession()
        sid = created.sessionId
        setSessionId(sid)
        selectSession(sid)
      } catch {
        // createSession failed — don't disable input, let the user retry.
        return
      }
    }

    setInput('')
    setPending(true)
    try {
      await swarmApi.submitPrompt(sid, trimmed, undefined, { agentType: DEFAULT_FORMATION })
    } catch {
      // submitPrompt rejected before any run event arrived — reset pending so
      // the input isn't permanently stuck disabled.
      setPending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void swarmApi.quickPanelHide()
    } else if (e.key === 'Backspace' && input === '') {
      // Raycast-style: Backspace on empty input returns to the previous view.
      e.preventDefault()
      onBack()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-popover/82 backdrop-blur-[40px]">
      {/* Message list — uses the same Message/MessageContent/MessageResponse
          components as the main conversation thread for visual consistency. */}
      <div className="cmdscroll min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={scrollRef}>
        {bubbles.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">输入消息开始对话…</div>
        )}
        {bubbles.map((b) => (
          <Message className="group mb-3" from={b.role === 'user' ? 'user' : 'assistant'} key={b.key}>
            <MessageContent>
              {b.role === 'assistant' ? (
                <MessageResponse>{b.text || (isStreaming ? '…' : '')}</MessageResponse>
              ) : (
                <span className="whitespace-pre-wrap">{b.text}</span>
              )}
            </MessageContent>
          </Message>
        ))}
      </div>

      {/* Input */}
      <div className="border-border/60 border-t px-4 py-3">
        <input
          className="bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
          disabled={isStreaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isStreaming ? 'Agent 正在回复…' : '输入消息,Enter 发送,⌫ 返回…'}
          ref={inputRef}
          value={input}
        />
      </div>
    </div>
  )
}
