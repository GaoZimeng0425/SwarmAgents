import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod, ServiceToMain } from '@shared/types/service-ipc'
import type { PermissionDecision } from '@shared/types/ui'

const log = createLogger({ process: 'main' }).child({ component: 'service-client' })

// Minimal duplex channel the client needs. Electron's UtilityProcess satisfies
// this structurally (postMessage + EventEmitter on/off); tests pass a fake.
export type ServiceTransport = {
  postMessage(message: unknown): void
  on(channel: 'message', listener: (message: unknown) => void): void
  off(channel: 'message', listener: (message: unknown) => void): void
}

type ServiceClientConfig = {
  transport: ServiceTransport
  onEvent?: (event: string, data: unknown) => void
}

export type ServiceClient = {
  connect(): Promise<void>
  disconnect(): void
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  submitGoal(sessionId: string, goal: string): Promise<{ taskId: string }>
  listSessions(): Promise<import('@shared/types/ui').SessionSummary[]>
  getSessionTasks(sessionId: string): Promise<import('@shared/types/task').Task[]>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
}

export function createServiceClient(cfg: ServiceClientConfig): ServiceClient {
  const { transport, onEvent } = cfg
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let listener: ((message: unknown) => void) | null = null

  const handle = (message: unknown): void => {
    const msg = message as ServiceToMain
    if (msg.kind === 'response') {
      const p = pending.get(msg.id)
      if (!p) {
        log.warn({ msg: 'response for unknown request id', id: msg.id })
        return
      }
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      if (onEvent) onEvent(msg.event, msg.data)
    }
  }

  function call<T>(method: ServiceMethod, args: unknown[]): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      transport.postMessage({ kind: 'request', id, method, args })
    })
  }

  return {
    connect() {
      listener = handle
      transport.on('message', listener)
      return Promise.resolve()
    },
    disconnect() {
      if (listener) transport.off('message', listener)
      listener = null
    },
    createSession(provider) {
      return call('createSession', [provider])
    },
    submitGoal(sessionId, goal) {
      return call('submitGoal', [sessionId, goal])
    },
    listSessions() {
      return call('listSessions', [])
    },
    getSessionTasks(sessionId) {
      return call('getSessionTasks', [sessionId])
    },
    async decidePermission(sessionId, actionId, decision) {
      await call('decidePermission', [sessionId, actionId, decision])
    },
    async cancelTask(sessionId, taskId) {
      await call('cancelTask', [sessionId, taskId])
    },
  }
}
