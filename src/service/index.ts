import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceRequest } from '@shared/types/service-ipc'

import { createBroadcaster } from './broadcaster'
import { createConversationStore } from './conversation-store'
import { createDispatcher } from './dispatcher'
import { createMemoryStore } from './memory-store'
import { createSessionManager } from './session-manager'
import { registerBuiltinTools } from './tools/builtins'
import { createToolRegistry } from './tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'index' })

// `process.parentPort` is injected by Electron only when this module runs as a
// utilityProcess. We type it locally so the service build stays decoupled from
// Electron's type package (it builds under the node tsconfig).
type ParentPort = {
  on(channel: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!parentPort) {
  log.error({ msg: 'no parentPort — service must be launched as a utilityProcess' })
  process.exit(1)
}

const dbPath = process.env.SWARM_SERVICE_DB_PATH ?? join(tmpdir(), 'swarm-agent-service.db')
const memoryPath = process.env.SWARM_SERVICE_MEMORY_PATH ?? join(tmpdir(), 'swarm-agent-memory.json')

const store = createConversationStore(dbPath)
const memoryStore = createMemoryStore(memoryPath)
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))

const toolRegistry = createToolRegistry()
registerBuiltinTools(toolRegistry, { memoryStore })

const providerRegistry = new Map<string, ProviderInjection>()

const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
})

const dispatch = createDispatcher({
  manager,
  registerProvider: (provider) => {
    providerRegistry.set(provider.id, provider)
  },
})

parentPort.on('message', async (e) => {
  const msg = e.data as ServiceRequest
  if (msg?.kind !== 'request') return
  try {
    const result = await dispatch(msg.method, msg.args)
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: true, result })
  } catch (err) {
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: false, error: String(err) })
  }
})

parentPort.postMessage({ kind: 'ready' })
log.info({ msg: 'service started', dbPath })

process.on('exit', () => store.close())
