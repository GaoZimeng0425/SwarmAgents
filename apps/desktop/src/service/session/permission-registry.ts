import { createLogger } from '@shared/logger'
import type { PermissionDecision, Risk } from '@swarm/protocol'
import { ulid } from 'ulid'

const log = createLogger({ process: 'service' }).child({ component: 'permission' })

type PendingPermission = {
  toolName: string
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
  // Tool names the user chose to 'grant_always'. Session-lifetime, in-memory:
  // one registry per session, shared by every run (turn/work/child), so the
  // allowlist applies to sub-agents too. Never persisted.
  const alwaysAllow = new Set<string>()

  return {
    // Approval is a human action, so a request waits indefinitely for an
    // explicit decision — there is no auto-deny timeout. The only non-user
    // resolution is task abort via `signal`, which fail-safe denies so a
    // pending medium/high tool never runs without consent.
    request(req, signal) {
      const actionId = ulid()
      return new Promise<PermissionDecision>((resolve) => {
        // Session-scoped standing grant for this tool: auto-approve without a
        // prompt (no broadcast). Checked even when aborted-before-prompt below
        // would deny — a standing grant means the user already consented.
        if (alwaysAllow.has(req.toolName)) {
          log.info({ msg: 'permission auto-granted (always allow)', taskId: req.taskId, toolName: req.toolName })
          resolve('grant')
          return
        }
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
        pending.set(actionId, { toolName: req.toolName, resolve, cleanup })
        log.info({ msg: 'permission requested', actionId, taskId: req.taskId, toolName: req.toolName, risk: req.risk })
        broadcast('message.permission_request', { actionId, ...req })
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
      if (decision === 'grant_always') {
        // Record the standing grant, then resolve THIS request as a normal grant
        // — the engine only understands 'grant'/'deny'/'skip'.
        alwaysAllow.add(p.toolName)
        log.info({ msg: 'permission resolved (always allow)', actionId, toolName: p.toolName })
        p.resolve('grant')
        return
      }
      log.info({ msg: 'permission resolved', actionId, decision })
      p.resolve(decision)
    },
  }
}
