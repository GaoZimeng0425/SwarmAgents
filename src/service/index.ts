import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceRequest } from '@shared/types/service-ipc'
import type { WebSearchInjection } from '@shared/types/web-search'

import { createBroadcaster } from './broadcaster'
import { createConversationStore } from './conversation-store'
import { createCronScheduler } from './cron-scheduler'
import { createDispatcher } from './dispatcher'
import { createMcpManager } from './mcp/manager'
import { createMcpRequestRegistry } from './mcp-request-registry'
import { createMemoryStore } from './memory-store'
import { createSessionManager } from './session-manager'
import { createSkillStore } from './skills/store'
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
const skillsPath = process.env.SWARM_SERVICE_SKILLS_PATH ?? join(tmpdir(), 'swarm-agent-skills')

const store = createConversationStore(dbPath)
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))
const memoryStore = createMemoryStore(memoryPath, () => broadcaster.broadcast('memory.changed', { ts: Date.now() }))
const skillStore = createSkillStore({ dir: skillsPath })

const toolRegistry = createToolRegistry()

const providerRegistry = new Map<string, ProviderInjection>()

// Live web-search config, pushed from Main and read per call by the web_search
// tool. Defaults to 'auto' (env-var fallback) until Main sends the persisted one.
let webSearchConfig: WebSearchInjection = { provider: 'auto' }

// Lets the mcp_add tool persist a server via Main (the config store lives there).
const mcpRequests = createMcpRequestRegistry((event, data) => broadcaster.broadcast(event, data))

const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
  skillStore,
  mcpRequests,
})

const scheduler = createCronScheduler({
  store,
  fire: (sessionId, goal) => {
    manager.submitGoal(sessionId, goal)
  },
})
registerBuiltinTools(toolRegistry, {
  memoryStore,
  skillStore,
  scheduler,
  getWebSearchConfig: () => webSearchConfig,
})
scheduler.start()

const mcpManager = createMcpManager({
  toolRegistry,
  emitStatus: (statuses) => broadcaster.broadcast('mcp.status', statuses),
})

const dispatch = createDispatcher({
  manager,
  registerProvider: (provider) => {
    providerRegistry.set(provider.id, provider)
  },
  setMcpServers: (configs) => mcpManager.setServers(configs),
  getMcpStatus: () => mcpManager.getStatus(),
  resolveMcpAdd: (requestId, result) => mcpRequests.resolve(requestId, result),
  setWebSearchConfig: (config) => {
    webSearchConfig = config
  },
  listSkills: () => skillStore.list(),
  saveSkill: (skill) => skillStore.save(skill),
  deleteSkill: (name) => skillStore.remove(name),
  listMemory: (namespace) => memoryStore.list(namespace),
})

parentPort.on('message', async (e) => {
  const msg = e.data as ServiceRequest
  if (msg?.kind !== 'request') return
  const t0 = Date.now()
  log.debug({ msg: 'request', method: msg.method, id: msg.id })
  try {
    const result = await dispatch(msg.method, msg.args)
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: true, result })
    log.debug({ msg: 'request ok', method: msg.method, id: msg.id, durationMs: Date.now() - t0 })
  } catch (err) {
    log.error({
      msg: 'request failed',
      method: msg.method,
      id: msg.id,
      durationMs: Date.now() - t0,
      err: err instanceof Error ? err.message : String(err),
    })
    parentPort.postMessage({ kind: 'response', id: msg.id, ok: false, error: String(err) })
  }
})

parentPort.postMessage({ kind: 'ready' })
log.info({ msg: 'service started', dbPath })

process.on('exit', () => {
  scheduler.dispose()
  void mcpManager.dispose()
  store.close()
})
