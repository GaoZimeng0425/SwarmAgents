import { useEffect, useMemo, useRef, useState } from 'react'
import { applyWireEvent, buildSegments, emptySessionView, hydrate, type SessionView } from '@swarm/shared'
import { Button, Input } from '@swarm/ui'
import { ChevronLeft } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'

import { PermissionCard, type PermissionPrompt } from '@/components/permission-card'
import { SegmentView } from '@/components/segment-view'
import { useSessionViewSource } from '@/hooks/use-session-view-source'
import { useConnection } from '@/stores/connection-store'

export function SessionDetailPage(): React.JSX.Element {
  const { id: sessionId } = useParams<{ id: string }>()
  const { client } = useConnection()
  const subscribe = useSessionViewSource()
  const navigate = useNavigate()
  const [view, setView] = useState<SessionView>(emptySessionView)
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Catch-up load on mount / session switch: pull the full entry log and
  // start a fresh view from it. Live events fold in separately below.
  useEffect(() => {
    setView(emptySessionView())
    setPermissions([])
    if (!client || !sessionId) return
    let alive = true
    void client.getSessionEntries(sessionId).then((rows) => {
      if (!alive) return
      setView((prev) => hydrate(prev, rows))
    })
    return () => {
      alive = false
    }
  }, [client, sessionId])

  // Fold live wire events for this session into the view, and track pending
  // permission_request prompts — cleared on decide or when the run ends.
  useEffect(() => {
    if (!subscribe || !sessionId) return
    return subscribe((e) => {
      if (e.sessionId !== sessionId) return
      setView((prev) => applyWireEvent(prev, e))
      if (e.kind === 'permission_request') {
        setPermissions((prev) =>
          prev.some((p) => p.actionId === e.actionId)
            ? prev
            : [...prev, { actionId: e.actionId, risk: e.risk, summary: e.summary }]
        )
      }
      if (e.kind === 'agent_end') setPermissions([])
    })
  }, [subscribe, sessionId])

  const segments = useMemo(() => buildSegments(view), [view])

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
      setPermissions((prev) => prev.filter((p) => p.actionId !== perm.actionId))
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
