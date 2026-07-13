import { useEffect } from 'react'
import { applyEvent, type MessageRecord } from '@shared/lib/apply-event'
import type { UIEvent } from '@swarm/protocol'
import { SYSTEM_SESSION_ID } from '@swarm/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { MEMORY_KEY } from '@/hooks/use-memory'
import { MESSAGES_KEY } from '@/hooks/use-messages'
import { useSettingsNav } from '@/hooks/use-settings-nav'
import { swarmApi } from '@/lib/api'
import { parseChoiceCard } from '@/lib/choice-notification'
import { type PermissionPrompt, usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'
import { routeToSection } from '@/stores/settings-dialog'

// Milestone events that warrant a toast for a background session. Streaming
// noise (progress/usage/tool_call/plan/dispatched) only marks unread.
const TOAST_KINDS = new Set(['message.created', 'message.complete', 'message.permission_request'])

function activityMessage(kind: string, title: string): string {
  if (kind === 'message.created') return `「${title}」开始了新任务`
  if (kind === 'message.complete') return `「${title}」任务已完成`
  return `「${title}」需要你的回复` // message.permission_request
}

// Fire a native OS notification for a render_ui choice card. Guarded by the
// browser permission; a no-op until the user grants it.
function notifyChoice(title: string, body: string, messageId: string, onClick: () => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const n = new Notification(title, { body, tag: `choice-${messageId}` })
  n.onclick = onClick
}

function buildPrompt(e: Extract<UIEvent, { kind: 'message.permission_request' }>): PermissionPrompt {
  return {
    actionId: e.actionId,
    sessionId: e.sessionId,
    messageId: e.messageId,
    risk: e.risk,
    summary: e.summary,
    payload: e.payload,
  }
}

export function useEventsSubscription(): void {
  const qc = useQueryClient()
  const push = usePermissionStore((s) => s.push)
  const navigate = useNavigate()
  const { openSettings } = useSettingsNav()

  // Ask once for OS-notification permission so choice cards can ping the user.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])

  // swarmagents://chat/<id> deep links. Pull any link that arrived before this
  // mount (cold start), then subscribe to links pushed while the app runs.
  useEffect(() => {
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
  }, [navigate])

  // Main → renderer Settings open (menu / deep-link). Mounted app-wide via
  // EventsBridge, so it works regardless of the current route. Opens the
  // settings dialog at the mapped section by setting the ?settings= search
  // param (router-derived now, via useSettingsNav).
  useEffect(() => {
    return swarmApi.onNavigateToSettings((route) => {
      openSettings(routeToSection(route))
    })
  }, [openSettings])

  useEffect(() => {
    return swarmApi.subscribeEvents((e) => {
      qc.setQueryData<MessageRecord[]>(MESSAGES_KEY, (prev = []) => applyEvent(prev, e))

      // Surface activity in sessions other than the one being viewed: mark the
      // session unread (dot in the list) and toast on milestone events.
      if ('sessionId' in e && e.sessionId && e.kind.startsWith('message.')) {
        const store = useSessionsStore.getState()
        if (e.sessionId !== store.selectedSessionId) {
          store.markUnread(e.sessionId)
          if (TOAST_KINDS.has(e.kind)) {
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
          // session.created/updated events don't carry composer settings; keep
          // whatever the list/optimistic update already stored for this session.
          cwd: existing?.cwd,
          permissionMode: existing?.permissionMode,
          executionMode: existing?.executionMode,
          // Likewise the usage totals — these events don't carry them, so keep
          // the last listSessions value rather than blanking the list figure.
          tokensUsed: existing?.tokensUsed,
          usdCents: existing?.usdCents,
        })
      }
      if (e.kind === 'memory.changed') {
        void qc.invalidateQueries({ queryKey: MEMORY_KEY })
      }
      // Live-update contextTokens/contextWindow on the session store so the
      // composer ring refreshes without waiting for a listSessions refetch.
      if (e.kind === 'message.usage' && e.sessionId) {
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
      if (e.kind === 'message.permission_request') {
        // All risk levels (medium + high) surface in the inline permission panel.
        push(buildPrompt(e))
      }

      // A render_ui single/multi-select card pings the OS, but only when the
      // user can't already see it: window unfocused, or a non-active session.
      const choice = parseChoiceCard(e)
      if (choice && 'sessionId' in e && e.sessionId && 'messageId' in e) {
        const store = useSessionsStore.getState()
        const sid = e.sessionId
        if (!document.hasFocus() || sid !== store.selectedSessionId) {
          const title = store.sessions.find((s) => s.id === sid)?.title ?? 'Untitled chat'
          notifyChoice(title, choice.question, e.messageId, () => {
            window.focus()
            void navigate({ to: '/session/$sessionId', params: { sessionId: sid } })
          })
        }
      }
    })
  }, [qc, push, navigate])
}
