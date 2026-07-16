import { useEffect } from 'react'
import type { AgentWireEvent, UIEvent } from '@swarm/protocol'
import { isAgentWireEvent } from '@swarm/protocol'
import { applyWireEvent, type SessionView, SYSTEM_SESSION_ID } from '@swarm/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { MEMORY_KEY } from '@/hooks/use-memory'
import { RUNNING_SESSIONS_KEY, sessionViewKey } from '@/hooks/use-session-view'
import { useSettingsNav } from '@/hooks/use-settings-nav'
import { swarmApi } from '@/lib/api'
import { type PermissionPrompt, usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'
import { routeToSection } from '@/stores/settings-dialog'

// Milestone wire events that warrant a toast for a background session. Streaming
// noise (turn/message/tool events) only marks the session unread.
const TOAST_KINDS = new Set<AgentWireEvent['kind']>(['agent_start', 'agent_end', 'permission_request'])

function activityMessage(kind: AgentWireEvent['kind'], title: string): string {
  if (kind === 'agent_start') return `「${title}」开始了新任务`
  if (kind === 'agent_end') return `「${title}」任务已完成`
  return `「${title}」需要你的回复` // permission_request
}

function buildPrompt(e: Extract<AgentWireEvent, { kind: 'permission_request' }>): PermissionPrompt {
  return {
    actionId: e.actionId,
    sessionId: e.sessionId,
    runId: e.runId,
    risk: e.risk,
    summary: e.summary,
    payload: e.payload,
  }
}

export function useEventsSubscription(opts: { isQuickPanel?: boolean } = {}): void {
  const { isQuickPanel = false } = opts
  const qc = useQueryClient()
  const push = usePermissionStore((s) => s.push)
  const navigate = useNavigate()
  const { openSettings } = useSettingsNav()

  // swarmagents://chat/<id> deep links. Pull any link that arrived before this
  // mount (cold start), then subscribe to links pushed while the app runs.
  // Skip in the quick panel — the main window owns deep-link consumption to
  // avoid a race where the hidden panel steals the cold-start link.
  useEffect(() => {
    if (isQuickPanel) return
    const open = (payload: { sessionId?: string; route?: string }): void => {
      if (payload.sessionId) {
        void navigate({ to: '/session/$sessionId', params: { sessionId: payload.sessionId } })
      } else if (payload.route) {
        void navigate({ to: payload.route as never })
      }
    }
    void swarmApi.consumePendingDeepLink().then((d) => {
      if (d) open({ sessionId: d.sessionId })
    })
    return swarmApi.onNavigateToSession(open)
  }, [navigate, isQuickPanel])

  // Main → renderer Settings open (menu / deep-link). Mounted app-wide via
  // EventsBridge, so it works regardless of the current route.
  // Skip in the quick panel — settings navigation is main-window-only.
  useEffect(() => {
    if (isQuickPanel) return
    return swarmApi.onNavigateToSettings((route) => {
      openSettings(routeToSection(route))
    })
  }, [openSettings, isQuickPanel])

  useEffect(() => {
    const setRunning = (sessionId: string, running: boolean): void => {
      qc.setQueryData<Set<string>>(RUNNING_SESSIONS_KEY, (prev) => {
        const next = new Set(prev ?? [])
        if (running) next.add(sessionId)
        else next.delete(sessionId)
        return next
      })
    }

    // Fold a v3 agent wire event into per-session view state + cross-cutting stores.
    const handleWireEvent = (e: AgentWireEvent): void => {
      // Fold into the session's live view — but only when a view cache already
      // exists (the session is being viewed / recently viewed). Creating one
      // here from a mid-stream event would strand the history below its first
      // rowId; unopened sessions get a full catch-up load in useSessionView.
      qc.setQueryData<SessionView>(sessionViewKey(e.sessionId), (prev) => (prev ? applyWireEvent(prev, e) : prev))

      // Cross-session running set (dashboard / session list live status).
      if (e.kind === 'agent_start') setRunning(e.sessionId, true)
      if (e.kind === 'agent_end') setRunning(e.sessionId, false)

      // Live context-fill for the composer ring, without a listSessions refetch.
      if (e.kind === 'turn_end') {
        const store = useSessionsStore.getState()
        const existing = store.sessions.find((s) => s.id === e.sessionId)
        if (existing) {
          store.upsert({
            ...existing,
            contextTokens: e.contextTokens ?? existing.contextTokens,
            contextWindow: e.contextWindow ?? existing.contextWindow,
          })
        }
      }

      // All risk levels surface in the inline permission panel.
      if (e.kind === 'permission_request') push(buildPrompt(e))

      // Background-session activity: mark unread + toast on milestones. Skip
      // toasts in the quick panel (hidden secondary window).
      const store = useSessionsStore.getState()
      if (e.sessionId !== store.selectedSessionId) {
        store.markUnread(e.sessionId)
        if (!isQuickPanel && TOAST_KINDS.has(e.kind)) {
          const sid = e.sessionId
          const title = store.sessions.find((s) => s.id === sid)?.title ?? 'Untitled chat'
          toast(activityMessage(e.kind, title), {
            id: `activity-${sid}`,
            action: {
              label: '查看',
              onClick: () => void navigate({ to: '/session/$sessionId', params: { sessionId: sid } }),
            },
          })
        }
      }
    }

    return swarmApi.subscribeEvents((e: UIEvent) => {
      if (isAgentWireEvent(e)) {
        handleWireEvent(e)
        return
      }
      // Non-agent UIEvents: session/memory bookkeeping.
      if (e.kind === 'session.created' || e.kind === 'session.updated') {
        const existing = useSessionsStore.getState().sessions.find((s) => s.id === e.sessionId)
        useSessionsStore.getState().upsert({
          id: e.sessionId,
          title: e.title,
          status: 'active',
          lastActiveAt: 'lastActiveAt' in e ? e.lastActiveAt : e.ts,
          taskCount: existing?.taskCount ?? 0,
          pinned: existing?.pinned ?? false,
          sortOrder: existing?.sortOrder ?? 0,
          isSystem: e.sessionId === SYSTEM_SESSION_ID,
          cwd: existing?.cwd,
          permissionMode: existing?.permissionMode,
          executionMode: existing?.executionMode,
          tokensUsed: existing?.tokensUsed,
          usdCents: existing?.usdCents,
        })
      }
      if (e.kind === 'memory.changed') {
        void qc.invalidateQueries({ queryKey: MEMORY_KEY })
      }
    })
  }, [qc, push, navigate, isQuickPanel])
}
