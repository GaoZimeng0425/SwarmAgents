import { createLogger } from '@shared/logger'
import type { PermissionDecision, Risk } from '@swarm/protocol'
import { ulid } from 'ulid'

const log = createLogger({ process: 'service' }).child({ component: 'permission' })

type PendingPermission = {
  resolve: (d: PermissionDecision) => void
  cleanup: () => void
}

export type PermissionRegistry = {
  request(
    req: {
      taskId: string
      toolName: string
      risk: Risk
      summary: string
      payload: unknown
    },
    signal?: AbortSignal
  ): Promise<PermissionDecision>
  resolve(actionId: string, decision: PermissionDecision): void
}

export function createPermissionRegistry(broadcast: (event: string, data: unknown) => void): PermissionRegistry {
  const pending = new Map<string, PendingPermission>()

  return {
    // Approval is a human action, so a request waits indefinitely for an
    // explicit decision — there is no auto-deny timeout. The only non-user
    // resolution is task abort via `signal`, which fail-safe denies so a
    // pending medium/high tool never runs without consent.
    request(req, signal) {
      const actionId = ulid()
      return new Promise<PermissionDecision>((resolve) => {
        if (signal?.aborted) {
          log.warn({ msg: 'permission request aborted before prompt', taskId: req.taskId, toolName: req.toolName })
          resolve('deny')
          return
        }
        const onAbort = (): void => {
          if (pending.delete(actionId)) {
            log.warn({
              msg: 'permission request aborted while pending',
              actionId,
              taskId: req.taskId,
              toolName: req.toolName,
            })
            resolve('deny')
          }
        }
        const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(actionId, { resolve, cleanup })
        log.info({ msg: 'permission requested', actionId, taskId: req.taskId, toolName: req.toolName, risk: req.risk })
        broadcast('run.permission_request', { actionId, ...req })
      })
    },

    resolve(actionId, decision) {
      const p = pending.get(actionId)
      if (!p) {
        // Stale decision: the request was already resolved (decided or aborted).
        log.warn({ msg: 'permission resolve for unknown action', actionId, decision })
        return
      }
      p.cleanup()
      pending.delete(actionId)
      log.info({ msg: 'permission resolved', actionId, decision })
      p.resolve(decision)
    },
  }
}
