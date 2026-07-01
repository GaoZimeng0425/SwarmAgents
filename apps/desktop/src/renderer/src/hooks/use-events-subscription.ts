import { useEffect } from 'react'
import { SYSTEM_SESSION_ID } from '@shared/system-session'
import type { UIEvent } from '@swarm/protocol'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { MEMORY_KEY } from '@/hooks/use-memory'
import { TASKS_KEY } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { applyEvent, type TaskRecord } from '@/lib/apply-event'
import { parseChoiceCard } from '@/lib/choice-notification'
import { type PermissionPrompt, usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'
import { routeToSection, useSettingsDialog } from '@/stores/settings-dialog'

// Milestone events that warrant a toast for a background session. Streaming
// noise (progress/usage/tool_call/plan/dispatched) only marks unread.
const TOAST_KINDS = new Set(['task.created', 'task.complete', 'task.permission_request'])

function activityMessage(kind: string, title: string): string {
  if (kind === 'task.created') return `「${title}」开始了新任务`
  if (kind === 'task.complete') return `「${title}」任务已完成`
  return `「${title}」需要你的回复` // task.permission_request
}

// Fire a native OS notification for a render_ui choice card. Guarded by the
// browser permission; a no-op until the user grants it.
function notifyChoice(title: string, body: string, taskId: string, onClick: () => void): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const n = new Notification(title, { body, tag: `choice-${taskId}` })
  n.onclick = onClick
}

function buildPrompt(e: Extract<UIEvent, { kind: 'task.permission_request' }>): PermissionPrompt {
  return {
    actionId: e.actionId,
    sessionId: e.sessionId,
    taskId: e.taskId,
    workerId: e.workerId,
    risk: e.risk,
    summary: e.summary,
    payload: e.payload,
  }
}

export function useEventsSubscription(): void {
  const qc = useQueryClient()
  const push = usePermissionStore((s) => s.push)
  const navigate = useNavigate()

  // Ask once for OS-notification permission so choice cards can ping the user.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])

  // swarmagents://chat/<id> deep links. Pull any link that arrived before this
  // mount (cold start), then subscribe to links pushed while the app runs.
  useEffect(() => {
    const open = (sessionId: string): void => {
      void navigate({ to: '/session/$sessionId', params: { sessionId } })
    }
    void swarmApi.consumePendingDeepLink().then((d) => {
      if (d) open(d.sessionId)
    })
    return swarmApi.onNavigateToSession(open)
  }, [navigate])

  // Main → renderer Settings open (menu / deep-link). Mounted app-wide via
  // EventsBridge, so it works regardless of the current route. Opens the
  // settings dialog at the mapped section instead of navigating to a route.
  useEffect(() => {
    return swarmApi.onNavigateToSettings((route) => {
      useSettingsDialog.getState().openSettings(routeToSection(route))
    })
  }, [])

  useEffect(() => {
    return swarmApi.subscribeEvents((e) => {
      qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => applyEvent(prev, e))

      // Surface activity in sessions other than the one being viewed: mark the
      // session unread (dot in the list) and toast on milestone events.
      if ('sessionId' in e && e.sessionId && e.kind.startsWith('task.')) {
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
      if (e.kind === 'task.permission_request') {
        // All risk levels (medium + high) surface in the inline permission panel.
        push(buildPrompt(e))
      }

      // A render_ui single/multi-select card pings the OS, but only when the
      // user can't already see it: window unfocused, or a non-active session.
      const choice = parseChoiceCard(e)
      if (choice && 'sessionId' in e && e.sessionId && 'taskId' in e) {
        const store = useSessionsStore.getState()
        const sid = e.sessionId
        if (!document.hasFocus() || sid !== store.selectedSessionId) {
          const title = store.sessions.find((s) => s.id === sid)?.title ?? 'Untitled chat'
          notifyChoice(title, choice.question, e.taskId, () => {
            window.focus()
            void navigate({ to: '/session/$sessionId', params: { sessionId: sid } })
          })
        }
      }
    })
  }, [qc, push, navigate])
}
