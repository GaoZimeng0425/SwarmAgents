// Pure request router. Maps a (method, args) RPC pair to a SessionManager
// call and returns a JSON-serialisable result. Replaces the URL/method
// matching that lived in the HTTP server. No transport, no I/O — trivially
// unit-testable.

import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod } from '@shared/types/service-ipc'
import type { PermissionDecision } from '@shared/types/ui'
import type { SessionManager } from './session-manager'

type DispatcherConfig = {
  manager: SessionManager
  registerProvider(provider: ProviderInjection): void
}

export type Dispatcher = (method: ServiceMethod, args: unknown[]) => unknown

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const { manager, registerProvider } = cfg
  return (method, args) => {
    switch (method) {
      case 'createSession': {
        const [provider] = args as [ProviderInjection]
        registerProvider(provider)
        return manager.createSession(provider)
      }
      case 'submitGoal': {
        const [sessionId, goal] = args as [string, string]
        return manager.submitGoal(sessionId, goal)
      }
      case 'listSessions':
        return manager.listSessions()
      case 'getSessionTasks': {
        const [sessionId] = args as [string]
        return manager.getSessionTasks(sessionId)
      }
      case 'decidePermission': {
        const [sessionId, actionId, decision] = args as [string, string, PermissionDecision]
        manager.resolvePermission(sessionId, actionId, decision)
        return { ok: true }
      }
      case 'cancelTask':
        // Parity with the old HTTP route: acknowledged, not yet wired to a
        // real cancellation path in SessionManager.
        return { ok: true }
      default:
        throw new Error(`unknown method: ${String(method)}`)
    }
  }
}
