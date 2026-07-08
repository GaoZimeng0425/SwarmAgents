import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { ProviderInjection, ServiceRequest, WebSearchInjection } from '@swarm/protocol'
import { type BudgetConfig, defaultBudgetConfig } from '@swarm/protocol'
import { defaultAgents, retiredBuiltinIds } from '@swarm/shared'

import { createAgentStore, syncBuiltinAgents } from './agents/store'
import { createAnalyzeArticle } from './article/analyze'
import { createCollectArticle } from './article/collect'
import { createArticleStore } from './article/store'
import { createClaudeCodeManager } from './claude-code/manager'
import { createConversationStore } from './conversation/store'
import { createCronScheduler } from './cron/scheduler'
import { createAnalyzeEmail } from './gmail/analyze'
import { createAnalyzeThread } from './gmail/analyze-thread'
import { createMainRpc } from './gmail/main-rpc'
import { createHookDispatcher, createHooksStore } from './hooks'
import { createBroadcaster } from './ipc/broadcaster'
import { createDispatcher } from './ipc/dispatcher'
import { createMcpManager } from './mcp/manager'
import { createMemoryStore } from './memory/store'
import { createSessionService } from './session/session-service'
import { builtinSkills } from './skills/builtins'
import { createSkillStore } from './skills/store'
import { createToolTogglesStore } from './tool-toggles/store'
import { registerBuiltinTools } from './tools/builtins'
import { createToolRegistry } from './tools/registry'
import { createResearchRepo } from './trending/research'
import { createRepoResearchStore } from './trending/research-store'

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
// Session-markdown exports land here (the command palette's "export" action).
const exportsDir = process.env.SWARM_SERVICE_EXPORTS_DIR ?? join(tmpdir(), 'swarm-agent-exports')
// Collected-articles store. The store owns its filename (collected-articles.json,
// see article/store.ts), so this is a directory, not a file path — mirroring the
// agents/skills dir pattern. Defaults to tmpdir() in dev (Main pins the real
// userData dir before spawning this process in production).
const articlesDir = process.env.SWARM_SERVICE_ARTICLES_DIR ?? tmpdir()

const store = createConversationStore(dbPath)
const broadcaster = createBroadcaster((event, data) => parentPort.postMessage({ kind: 'event', event, data }))
const memoryStore = createMemoryStore(memoryPath, () => broadcaster.broadcast('memory.changed', { ts: Date.now() }))
// The MCP config lives next to the skills dir under userData (see main wiring),
// so the operations manual can cite its real path without a separate env var.
const mcpConfigPath = join(dirname(skillsPath), 'mcp-servers.json')
const skillStore = createSkillStore({ dir: skillsPath, builtins: builtinSkills({ mcpConfigPath }) })
// Reload + notify the renderer when the skills dir is edited outside the app
// (a folder dropped in by hand or written by the agent's fs tools), so the
// settings list updates live instead of only after a restart.
const offSkillWatch = skillStore.watch(() => broadcaster.broadcast('skills.changed', { ts: Date.now() }))
// Reconcile the shipped builtins to disk on every boot: add new ones, update
// changed ones, and prune retired ids — so an upgrade's agent changes land
// without a manual reset. User-authored agents are untouched.
syncBuiltinAgents(agentsPath, defaultAgents, retiredBuiltinIds)
const agentStore = createAgentStore({ dir: agentsPath })
const articleStore = createArticleStore({ userDataDir: articlesDir })
// Agent research results for trending repos share the articles userData dir
// (distinct filename repo-research.json). The trending list is fetched live in
// Main, so this is the only server-side trending state.
const repoResearchStore = createRepoResearchStore({ userDataDir: articlesDir })
// Reload + notify the renderer when the agents dir is edited outside the app
// (a folder dropped in by hand or written by the agent's fs tools), so the
// Agents view updates live instead of only after a restart.
const offAgentWatch = agentStore.watch(() => broadcaster.broadcast('agents.changed', { ts: Date.now() }))
// The article store mutates from an EXTERNAL source (the browser extension
// pushes over WS), so the renderer's useQuery would never see new articles
// without this broadcast. Mirrors the agents/skills watch pattern above.
const offArticleWatch = articleStore.watch(() => broadcaster.broadcast('articles.changed', { ts: Date.now() }))
// App-wide enable/disable for built-in tool groups + skills, alongside the MCP
// config. MCP servers keep their own enable flag (see mcpManager).
const toolToggles = createToolTogglesStore({ filePath: join(dirname(skillsPath), 'tool-toggles.json') })
// Claude-Code-style hooks: read-only config of event name → command, fired
// alongside the wire broadcast of each run.* event.
const hooksPath = process.env.SWARM_SERVICE_HOOKS_PATH ?? join(dirname(skillsPath), 'hooks.json')
const hookDispatcher = createHookDispatcher({ store: createHooksStore({ filePath: hooksPath }) })

const toolRegistry = createToolRegistry()
toolRegistry.setDisabledGroups(toolToggles.get().disabledToolGroups)

const providerRegistry = new Map<string, ProviderInjection>()

// Live web-search config, pushed from Main and read per call by the web_search
// tool. Defaults to 'auto' (env-var fallback) until Main sends the persisted one.
let webSearchConfig: WebSearchInjection = { provider: 'auto' }

// Live per-task budgets, pushed from Main and read at task creation. Defaults
// match the previous hardcoded values until Main sends the persisted config.
let budgetConfig: BudgetConfig = defaultBudgetConfig()

const service = createSessionService({
  store,
  broadcaster,
  maxConcurrent: 4,
  getProvider: (key) => providerRegistry.get(key),
  toolRegistry,
  skillStore,
  agentStore,
  getBudgetConfig: () => budgetConfig,
  isSkillEnabled: (name) => toolToggles.isSkillEnabled(name),
  exportsDir,
  dispatchHook: hookDispatcher,
})

const scheduler = createCronScheduler({
  store,
  fire: (sessionId, goal, onComplete) => {
    // submitPrompt returns { runId }; the scheduler records it as its task id.
    const { runId } = service.submitPrompt(sessionId, goal, [], onComplete)
    return { taskId: runId }
  },
  // Cron jobs are global: own + fire them in the dedicated system session, not
  // the conversation that issued schedule_task, so every session sees them and
  // they survive that conversation's deletion.
  resolveJobSession: (fromSessionId) => service.ensureSystemSession(fromSessionId),
  isRunTerminal: (runId) => service.terminalRegistry.isTerminal(runId),
  runTerminalStatus: (runId) => service.terminalRegistry.getStatus(runId),
})
// Drives Claude Code sessions the agent operates via cc_* tools. The SDK is
// loaded lazily on first cc_start, so constructing it here is cheap.
const claudeCode = createClaudeCodeManager()

// Close out runs dispatched-but-never-terminal from a previous process: append
// a synthetic task.error to run_events (replay reaches terminal) and mark each
// terminal in the registry.
service.markInterruptedRunsTerminal()

// Service-side main-rpc client: gmail.* tools call mainRpc('gmail.search', [...]),
// which posts a mainRequest that Main answers with a mainResponse. The client
// resolves the pending promise for each matched id. subscribe adds a second
// parentPort 'message' listener (the ServiceRequest handler filters by kind, so
// there is no conflict); utilityProcess parentPort has no off(), so unsubscribe
// is a no-op — the listener lives for the process lifetime.
const mainRpc = createMainRpc({
  post: (m) => parentPort.postMessage(m),
  subscribe: (fn) => {
    const listener = (e: { data: unknown }): void => fn(e.data)
    parentPort.on('message', listener)
    return () => {}
  },
})

registerBuiltinTools(toolRegistry, {
  memoryStore,
  skillStore,
  scheduler,
  claudeCode,
  getWebSearchConfig: () => webSearchConfig,
  isSkillEnabled: (name) => toolToggles.isSkillEnabled(name),
  gmailMainRpc: mainRpc.mainRpc,
  calendarMainRpc: mainRpc.mainRpc,
})
scheduler.start()

const mcpManager = createMcpManager({
  toolRegistry,
  emitStatus: (statuses) => broadcaster.broadcast('mcp.status', statuses),
})

const dispatch = createDispatcher({
  service,
  analyzeEmail: createAnalyzeEmail({ broadcaster, agentStore, toolRegistry, getBudgetConfig: () => budgetConfig }),
  analyzeThread: createAnalyzeThread({ broadcaster, agentStore, toolRegistry, getBudgetConfig: () => budgetConfig }),
  collectArticle: createCollectArticle({ store: articleStore }),
  analyzeArticle: createAnalyzeArticle({
    broadcaster,
    agentStore,
    store: articleStore,
    toolRegistry,
    getBudgetConfig: () => budgetConfig,
  }),
  // The store's list/get/delete are sync; the dispatcher contract returns
  // Promises for these (renderer awaits), so wrap them.
  listArticles: () => Promise.resolve(articleStore.list()),
  getArticleAnalysis: (id) => {
    const r = articleStore.get(id)
    return Promise.resolve({ summary: r?.summary ?? null, analyzedAt: r?.analyzedAt ?? null })
  },
  deleteArticle: (id) => {
    articleStore.delete(id)
    return Promise.resolve()
  },
  researchRepo: createResearchRepo({
    broadcaster,
    agentStore,
    store: repoResearchStore,
    toolRegistry,
    getBudgetConfig: () => budgetConfig,
  }),
  getRepoResearch: (repoName) => Promise.resolve(repoResearchStore.get(repoName)),
  researchedRepoNames: () => Promise.resolve(repoResearchStore.names()),
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
  // Annotate the UI list with each skill's live enabled state (the agent-facing
  // catalog filters separately, in the session manager / use_skill).
  listSkills: () => skillStore.list().map((s) => ({ ...s, enabled: toolToggles.isSkillEnabled(s.name) })),
  listAgents: () => agentStore.list(),
  saveAgent: (def) => agentStore.save(def),
  deleteAgent: (id) => agentStore.remove(id),
  restoreDefaultAgents: () => {
    const { written, removed } = syncBuiltinAgents(agentsPath, defaultAgents, retiredBuiltinIds)
    agentStore.reload()
    log.info({ msg: 'restore default agents', written, removed })
    return { ok: true as const, agents: agentStore.list() }
  },
  saveSkill: (skill) => skillStore.save(skill),
  deleteSkill: (name) => skillStore.remove(name),
  importSkill: (sourceDir, overwrite) => skillStore.importFolder(sourceDir, overwrite),
  getToolToggles: () => toolToggles.get(),
  setSkillEnabled: (name, enabled) => toolToggles.setSkillEnabled(name, enabled),
  setToolGroupEnabled: (group, enabled) => {
    const next = toolToggles.setToolGroupEnabled(group, enabled)
    toolRegistry.setDisabledGroups(next.disabledToolGroups)
    return next
  },
  listToolGroups: () =>
    toolRegistry.builtinGroups().map((g) => ({ ...g, enabled: toolToggles.isGroupEnabled(g.group) })),
  listMemory: (namespace) => memoryStore.list(namespace),
  listCronJobsForSession: (sessionId) => scheduler.listForSession(sessionId),
  listAllCronJobs: () => {
    const titleById = new Map(store.listSessions().map((s) => [s.id, s.title]))
    return scheduler.listAll().map((j) => {
      // Resolve the originating conversation. A non-null title means it still
      // exists (untitled chats fall back to a label, so null strictly means
      // "deleted or no recorded origin" — i.e. not navigable).
      const origin = j.originSessionId ? store.getSession(j.originSessionId) : undefined
      return {
        ...j,
        sessionTitle: titleById.get(j.sessionId) ?? store.getSession(j.sessionId)?.title ?? null,
        originSessionTitle: origin ? (origin.title ?? '未命名会话') : null,
      }
    })
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
  offSkillWatch()
  offAgentWatch()
  offArticleWatch()
  scheduler.dispose()
  void mcpManager.dispose()
  claudeCode.dispose()
  store.close()
})
