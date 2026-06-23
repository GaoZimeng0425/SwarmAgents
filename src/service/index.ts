import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { builtinAgents } from '@shared/agents/builtins'
import { createLogger } from '@shared/logger'
import { type BudgetConfig, defaultBudgetConfig } from '@shared/types/budgets'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceRequest } from '@shared/types/service-ipc'
import type { WebSearchInjection } from '@shared/types/web-search'

import { createAgentStore } from './agents/store'
import { createConversationStore } from './conversation/store'
import { createCronScheduler } from './cron/scheduler'
import { createBroadcaster } from './ipc/broadcaster'
import { createDispatcher } from './ipc/dispatcher'
import { createMcpManager } from './mcp/manager'
import { createMemoryStore } from './memory/store'
import { createSessionManager } from './session/manager'
import { builtinSkills } from './skills/builtins'
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
const agentsPath = process.env.SWARM_SERVICE_AGENTS_PATH ?? join(tmpdir(), 'swarm-agent-agents')

const store = createConversationStore(dbPath)
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))
const memoryStore = createMemoryStore(memoryPath, () => broadcaster.broadcast('memory.changed', { ts: Date.now() }))
// The MCP config lives next to the skills dir under userData (see main wiring),
// so the operations manual can cite its real path without a separate env var.
const mcpConfigPath = join(dirname(skillsPath), 'mcp-servers.json')
const skillStore = createSkillStore({ dir: skillsPath, builtins: builtinSkills({ mcpConfigPath }) })
const agentStore = createAgentStore({ dir: agentsPath, builtins: builtinAgents })

const toolRegistry = createToolRegistry()

const providerRegistry = new Map<string, ProviderInjection>()

// Live web-search config, pushed from Main and read per call by the web_search
// tool. Defaults to 'auto' (env-var fallback) until Main sends the persisted one.
let webSearchConfig: WebSearchInjection = { provider: 'auto' }

// Live per-task budgets, pushed from Main and read at task creation. Defaults
// match the previous hardcoded values until Main sends the persisted config.
let budgetConfig: BudgetConfig = defaultBudgetConfig()

const manager = createSessionManager({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
  skillStore,
  agentStore,
  getBudgetConfig: () => budgetConfig,
})

const scheduler = createCronScheduler({
  store,
  fire: (sessionId, goal, onComplete) => manager.submitGoal(sessionId, goal, [], undefined, onComplete),
  // Cron jobs are global: own + fire them in the dedicated system session, not
  // the conversation that issued schedule_task, so every session sees them and
  // they survive that conversation's deletion.
  resolveJobSession: (fromSessionId) => manager.ensureSystemSession(fromSessionId),
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
  setWebSearchConfig: (config) => {
    webSearchConfig = config
  },
  setBudgetConfig: (config) => {
    budgetConfig = config
  },
  listSkills: () => skillStore.list(),
  saveSkill: (skill) => skillStore.save(skill),
  deleteSkill: (name) => skillStore.remove(name),
  importSkill: (sourceDir, overwrite) => skillStore.importFolder(sourceDir, overwrite),
  listMemory: (namespace) => memoryStore.list(namespace),
  listCronJobsForSession: (sessionId) => scheduler.listForSession(sessionId),
  listAllCronJobs: () => {
    const titleById = new Map(store.listSessions().map((s) => [s.id, s.title]))
    return scheduler.listAll().map((j) => ({
      ...j,
      sessionTitle: titleById.get(j.sessionId) ?? store.getSession(j.sessionId)?.title ?? null,
    }))
  },
  listAllCronRuns: () => store.listAllCronRuns(),
  cancelCronJob: (id) => {
    scheduler.remove(id)
  },
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
