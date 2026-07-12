import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageWireEvent } from '@swarm/protocol'
import { buildSegments, hydrateSession, useMessages } from '@swarm/shared'
import { Button, Input } from '@swarm/ui'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import { PermissionCard, type PermissionPrompt } from '@/components/permission-card'
import { SegmentView } from '@/components/segment-view'
import { useConnection } from '@/stores/connection-store'

export function SessionDetailPage(): React.JSX.Element {
  const { id: sessionId } = useParams<{ id: string }>()
  const { client } = useConnection()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const messages = useMessages()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Hydrate history on mount / session switch. The subscribeEvents half of the
  // MessageEventSource is handled globally by EventsBridge, so here we pass a
  // no-op subscribeEvents — hydrateSession only needs getMessageEvents.
  useEffect(() => {
    if (!client || !sessionId) return
    void hydrateSession(
      qc,
      { getMessageEvents: (sid) => client.getMessageEvents(sid), subscribeEvents: () => () => {} },
      sessionId
    )
  }, [client, sessionId, qc])

  // Filter + order the global MessageRecord[] for this session, oldest-first
  // (ascending order) so the newest message lands at the bottom — the
  // conventional chat order and the direction the auto-scroll effect expects.
  const segments = useMemo(() => {
    const sessionMessages = messages.filter((m) => m.sessionId === sessionId).sort((a, b) => a.order - b.order)
    return sessionMessages.flatMap((r) => buildSegments(r.events))
  }, [messages, sessionId])

  // Extract pending permission_request prompts for this session.
  const permissions = useMemo<PermissionPrompt[]>(() => {
    const perms: PermissionPrompt[] = []
    for (const msg of messages.filter((m) => m.sessionId === sessionId)) {
      for (const evt of msg.events) {
        const wire = evt as MessageWireEvent
        if (wire.kind === 'message.permission_request' && wire.sessionId === sessionId) {
          perms.push({
            messageId: wire.messageId,
            actionId: wire.actionId,
            risk: wire.risk,
            summary: wire.summary,
          })
        }
      }
    }
    return perms
  }, [messages, sessionId])

  // Auto-scroll to bottom on new segments. segments.length is a trigger, not a
  // value read in the body, so biome's exhaustive-deps check would flag it —
  // the dependency is intentional here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: segments.length triggers scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [segments.length])

  const handleSend = async (): Promise<void> => {
    if (!client || !sessionId || !input.trim()) return
    const text = input.trim()
    setInput('')
    try {
      await client.submitPrompt(sessionId, text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePermission = async (perm: PermissionPrompt, decision: 'grant' | 'deny'): Promise<void> => {
    if (!client || !sessionId) return
    try {
      await client.decidePermission(sessionId, perm.actionId, decision)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-2xl flex-col bg-background">
      <header className="flex items-center gap-3 border-border border-b px-4 py-3">
        <Button aria-label="返回" onClick={() => navigate('/sessions')} size="icon" variant="ghost">
          <ChevronLeft className="size-5" />
        </Button>
        <h1 className="font-semibold text-base text-foreground">会话详情</h1>
      </header>

      {error && (
        <div className="border-destructive/30 border-b bg-destructive/5 px-4 py-1">
          <p className="text-destructive text-xs">{error}</p>
        </div>
      )}

      <div className="flex-1 space-y-0.5 overflow-y-auto py-2" ref={scrollRef}>
        {segments.map((seg) => (
          <SegmentView key={seg.key} segment={seg} />
        ))}
        {segments.length === 0 && <p className="px-4 py-12 text-center text-muted-foreground text-sm">暂无消息</p>}
      </div>

      {permissions.length > 0 && (
        <div className="space-y-1 border-border border-t px-0 py-2">
          {permissions.map((perm) => (
            <PermissionCard key={perm.actionId} onDecide={(d) => void handlePermission(perm, d)} perm={perm} />
          ))}
        </div>
      )}

      <form
        className="flex items-center gap-2 border-border border-t px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSend()
        }}
      >
        <Input className="flex-1" onChange={(e) => setInput(e.target.value)} placeholder="输入消息…" value={input} />
        <Button disabled={!input.trim()} type="submit">
          发送
        </Button>
      </form>
    </div>
  )
}
