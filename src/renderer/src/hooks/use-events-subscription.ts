import { useEffect } from 'react'
import type { UIEvent } from '@shared/types/ui'
import { useQueryClient } from '@tanstack/react-query'

import { TASKS_KEY } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { applyEvent, type TaskRecord } from '@/lib/apply-event'
import { type PermissionPrompt, usePermissionStore } from '@/stores/permission'

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

async function handleHighRisk(e: Extract<UIEvent, { kind: 'task.permission_request' }>): Promise<void> {
  // SKILL.md T3 + ship B.19: high-risk actions get a blocking system dialog.
  const role = await window.swarm.showConfirm({
    title: 'Action requires confirmation',
    message: e.summary,
    detail: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2),
    risk: e.risk,
    buttons: [
      { label: 'Deny', role: 'deny', destructive: true },
      { label: 'Skip', role: 'skip' },
      { label: 'Allow', role: 'grant' },
    ],
  })
  await window.swarm.decidePermission(e.actionId, role)
}

export function useEventsSubscription(): void {
  const qc = useQueryClient()
  const push = usePermissionStore((s) => s.push)

  useEffect(() => {
    return swarmApi.subscribeEvents((e) => {
      qc.setQueryData<TaskRecord[]>(TASKS_KEY, (prev = []) => applyEvent(prev, e))
      if (e.kind === 'task.permission_request') {
        if (e.risk === 'high') {
          // Native dialog; do NOT push into the drawer queue.
          void handleHighRisk(e)
        } else {
          push(buildPrompt(e))
        }
      }
    })
  }, [qc, push])
}
