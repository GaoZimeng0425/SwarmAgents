import type { Outbound } from '@shared/types/ipc'
import type { PermissionRequestPayload } from '@shared/types/permission'
import type { PermissionDecision } from '@shared/types/ui'
import { ulid } from 'ulid'

export type PermissionClient = {
  /** Send a permission.request Outbound and await the matching decision. */
  request: (req: Omit<PermissionRequestPayload, 'actionId'>) => Promise<PermissionDecision>
  /** Called by the worker entry when a permission.decision Inbound arrives. */
  resolve: (actionId: string, decision: PermissionDecision) => void
}

export function createPermissionClient(send: (msg: Outbound) => void): PermissionClient {
  const pending = new Map<string, (d: PermissionDecision) => void>()

  return {
    request(req) {
      const actionId = ulid()
      return new Promise<PermissionDecision>((resolve) => {
        pending.set(actionId, resolve)
        send({
          type: 'permission.request',
          actionId,
          risk: req.risk,
          summary: req.summary,
          payload: { taskId: req.taskId, toolName: req.toolName, args: req.payload },
        })
      })
    },
    resolve(actionId, decision) {
      const resolver = pending.get(actionId)
      if (!resolver) return
      pending.delete(actionId)
      resolver(decision)
    },
  }
}
