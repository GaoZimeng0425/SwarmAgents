import { useEffect } from 'react'
import type { UIEvent } from '@shared/types/ui'
import { useQueryClient } from '@tanstack/react-query'

import { MEMORY_KEY } from '@/hooks/use-memory'
import { TASKS_KEY } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { applyEvent, type TaskRecord } from '@/lib/apply-event'
import { useAskStore } from '@/stores/ask'
import { type PermissionPrompt, usePermissionStore } from '@/stores/permission'
import { useSessionsStore } from '@/stores/sessions'

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

  useEffect(() => {
    return swarmApi.subscribeEvents((e) => {
      qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => applyEvent(prev, e))
      if (e.kind === 'session.created' || e.kind === 'session.updated') {
        const existing = useSessionsStore.getState().sessions.find((s) => s.id === e.sessionId)
        useSessionsStore.getState().upsert({
          id: e.sessionId,
          title: e.title,
          status: 'active',
          lastActiveAt: 'lastActiveAt' in e ? e.lastActiveAt : e.ts,
          taskCount: existing?.taskCount ?? 0,
          pinned: existing?.pinned ?? false,
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
  }, [qc, push, pushAsk])
}
