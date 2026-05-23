import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import type { UIEvent } from '@shared/types/ui'

import { swarmApi } from '@/lib/api'
import { applyEvent, type TaskRecord } from '@/lib/apply-event'
import { TASKS_KEY } from '@/hooks/use-tasks'
import { usePermissionStore, type PermissionPrompt } from '@/stores/permission'

function buildPrompt(e: Extract<UIEvent, { kind: 'task.permission_request' }>): PermissionPrompt {
  return {
    actionId: e.actionId,
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

  useEffect(() => {
    return swarmApi.subscribeEvents((e) => {
      qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => applyEvent(prev, e))
      if (e.kind === 'task.permission_request') push(buildPrompt(e))
    })
  }, [qc, push])
}
