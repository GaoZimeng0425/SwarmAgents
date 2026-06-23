import type { PermissionDecision } from '@shared/types/ui'
import type { Risk } from '@shared/types/ipc'
import { ulid } from 'ulid'

type PendingPermission = {
  resolve: (d: PermissionDecision) => void
  timer: NodeJS.Timeout
}

export type PermissionRegistry = {
  request(req: {
    taskId: string
    toolName: string
    risk: Risk
    summary: string
    payload: unknown
  }): Promise<PermissionDecision>
  resolve(actionId: string, decision: PermissionDecision): void
}

const PERMISSION_TIMEOUT_MS = 30_000

export function createPermissionRegistry(
  broadcast: (event: string, data: unknown) => void,
): PermissionRegistry {
  const pending = new Map<string, PendingPermission>()

  return {
    request(req) {
      const actionId = ulid()
      return new Promise<PermissionDecision>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(actionId)) resolve('deny')
        }, PERMISSION_TIMEOUT_MS)
        timer.unref?.()
        pending.set(actionId, { resolve, timer })
        broadcast('task.permission_request', { actionId, ...req })
      })
    },

    resolve(actionId, decision) {
      const p = pending.get(actionId)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(actionId)
      p.resolve(decision)
    },
  }
}
