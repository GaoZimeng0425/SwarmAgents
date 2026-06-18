import { useEffect } from 'react'
import type { UIEvent } from '@shared/types/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { MEMORY_KEY } from '@/hooks/use-memory'
import { TASKS_KEY } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { applyEvent, type TaskRecord } from '@/lib/apply-event'
import { useAskStore } from '@/stores/ask'
import { type PermissionPrompt, usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

// Milestone events that warrant a toast for a background session. Streaming
// noise (progress/usage/tool_call/plan/dispatched) only marks unread.
const TOAST_KINDS = new Set(['task.created', 'task.complete', 'task.ask', 'task.permission_request'])

function activityMessage(kind: string, title: string): string {
  if (kind === 'task.created') return `「${title}」开始了新任务`
  if (kind === 'task.complete') return `「${title}」任务已完成`
  return `「${title}」需要你的回复` // task.ask / task.permission_request
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
  const pushAsk = useAskStore((s) => s.push)
  const navigate = useNavigate()

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
        })
      }
      if (e.kind === 'memory.changed') {
        void qc.invalidateQueries({ queryKey: MEMORY_KEY })
      }
      if (e.kind === 'task.permission_request') {
        // All risk levels (medium + high) surface in the inline permission panel.
        push(buildPrompt(e))
      }
      if (e.kind === 'task.ask') {
        pushAsk({
          askId: e.askId,
          sessionId: e.sessionId,
          taskId: e.taskId,
          question: e.question,
          options: e.options,
          mode: e.mode,
        })
      }
    })
  }, [qc, push, pushAsk, navigate])
}
