import type { AgentDefinition, AgentListItem, AgentMutationResult } from './types/agent'
import type { BudgetConfig } from './types/budgets'
import type { McpServerConfig, McpServerStatus } from './types/mcp'
import type { MemoryView } from './types/memory'
import type { ProviderInjection } from './types/provider'
import type { MainMethod, MainRequest, ServiceMethod, ServiceToMain } from './types/service-ipc'
import type { Skill, SkillMutationResult } from './types/skill'
import type { ToolGroupInfo, ToolToggles } from './types/tool-toggles'
import type { PermissionDecision } from './types/ui'
import type { WebSearchInjection } from './types/web-search'

// @swarm/protocol is logger-free (no pino dep) so it stays portable across
// desktop/extension/RN. Diagnostics go to console; desktop wraps if it needs
// structured pino output.
const log = console

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
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('./types/task').Attachment[],
    options?: import('./types/task').RunOptions
  ): Promise<{ runId: string }>
  analyzeEmail(req: import('./types/ui').AnalyzeEmailRequest): Promise<import('./types/ui').AnalyzeEmailResult>
  analyzeThread(req: import('./types/ui').AnalyzeThreadRequest): Promise<import('./types/ui').AnalyzeThreadResult>
  listSessions(): Promise<import('./types/ui').SessionSummary[]>
  getRunEvents(sessionId: string): Promise<import('./types/task').RunEvent[]>
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  updateSessionSettings(sessionId: string, settings: import('./types/ui').SessionSettings): Promise<void>
  reorderSessions(orderedIds: string[]): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelRun(sessionId: string, runId: string): Promise<void>
  interruptWith(sessionId: string, runId: string): Promise<void>
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): Promise<McpServerStatus[]>
  setWebSearchConfig(config: WebSearchInjection): Promise<void>
  setBudgetConfig(config: BudgetConfig): Promise<void>
  listSkills(): Promise<Skill[]>
  listAgents(): Promise<AgentListItem[]>
  saveAgent(def: AgentDefinition): Promise<AgentMutationResult>
  deleteAgent(id: string): Promise<AgentMutationResult>
  restoreDefaultAgents(): Promise<AgentMutationResult>
  saveSkill(skill: Skill): Promise<SkillMutationResult>
  deleteSkill(name: string): Promise<SkillMutationResult>
  importSkill(sourceDir: string, overwrite?: boolean): Promise<SkillMutationResult>
  getToolToggles(): Promise<ToolToggles>
  setSkillEnabled(name: string, enabled: boolean): Promise<ToolToggles>
  setToolGroupEnabled(group: string, enabled: boolean): Promise<ToolToggles>
  listToolGroups(): Promise<ToolGroupInfo[]>
  listMemory(namespace?: string): Promise<MemoryView[]>
  getUsageStats(rangeDays: number): Promise<import('./types/usage').UsageStats>
  listCronJobsForSession(sessionId: string): Promise<import('./types/ui').CronJobSummary[]>
  listAllCronJobs(): Promise<import('./types/ui').ScheduledTask[]>
  listAllCronRuns(): Promise<import('./types/ui').CronRun[]>
  cancelCronJob(id: string): Promise<void>
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown> | unknown): void
}

export function createServiceClient(cfg: ServiceClientConfig): ServiceClient {
  const { transport, onEvent } = cfg
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const mainRpcHandlers = new Map<MainMethod, (...args: unknown[]) => Promise<unknown> | unknown>()
  let listener: ((message: unknown) => void) | null = null

  const handle = (message: unknown): void => {
    const msg = message as ServiceToMain
    if (msg.kind === 'response') {
      const p = pending.get(msg.id)
      if (!p) {
        // The desktop host bridges an external WS peer onto this same service
        // transport; that peer's response ids are foreign to this client. Drop.
        return
      }
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      if (onEvent) onEvent(msg.event, msg.data)
    } else if (msg.kind === 'mainRequest') {
      const req = msg as MainRequest
      const handler = mainRpcHandlers.get(req.method)
      if (!handler) {
        log.warn({ msg: 'no main-rpc handler', method: req.method, id: req.id })
        transport.postMessage({ kind: 'mainResponse', id: req.id, ok: false, error: `no handler for ${req.method}` })
        return
      }
      Promise.resolve()
        .then(() => handler(...req.args))
        .then(
          (result) => transport.postMessage({ kind: 'mainResponse', id: req.id, ok: true, result }),
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            log.error({ msg: 'main-rpc handler threw', method: req.method, id: req.id, err: message })
            transport.postMessage({ kind: 'mainResponse', id: req.id, ok: false, error: message })
          }
        )
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
    registerMainRpc(method, fn) {
      mainRpcHandlers.set(method, fn)
    },
    createSession(provider) {
      return call('createSession', [provider])
    },
    submitGoal(sessionId, goal, attachments, options) {
      return call('submitGoal', [sessionId, goal, attachments, options])
    },
    analyzeEmail(req) {
      return call('analyzeEmail', [req])
    },
    analyzeThread(req) {
      return call('analyzeThread', [req])
    },
    listSessions() {
      return call('listSessions', [])
    },
    getRunEvents(sessionId) {
      return call('getRunEvents', [sessionId])
    },
    exportSessionMarkdown(sessionId) {
      return call('exportSessionMarkdown', [sessionId])
    },
    async deleteSession(sessionId) {
      await call('deleteSession', [sessionId])
    },
    async renameSession(sessionId, title) {
      await call('renameSession', [sessionId, title])
    },
    async setSessionPinned(sessionId, pinned) {
      await call('setSessionPinned', [sessionId, pinned])
    },
    async updateSessionSettings(sessionId, settings) {
      await call('updateSessionSettings', [sessionId, settings])
    },
    async reorderSessions(orderedIds) {
      await call('reorderSessions', [orderedIds])
    },
    async decidePermission(sessionId, actionId, decision) {
      await call('decidePermission', [sessionId, actionId, decision])
    },
    async cancelRun(sessionId, runId) {
      await call('cancelRun', [sessionId, runId])
    },
    async interruptWith(sessionId, runId) {
      await call('interruptWith', [sessionId, runId])
    },
    async setMcpServers(configs) {
      await call('setMcpServers', [configs])
    },
    getMcpStatus() {
      return call('getMcpStatus', [])
    },
    async setWebSearchConfig(config) {
      await call('setWebSearchConfig', [config])
    },
    async setBudgetConfig(config) {
      await call('setBudgetConfig', [config])
    },
    listSkills() {
      return call('listSkills', [])
    },
    listAgents() {
      return call('listAgents', [])
    },
    saveAgent(def) {
      return call('saveAgent', [def])
    },
    deleteAgent(id) {
      return call('deleteAgent', [id])
    },
    restoreDefaultAgents() {
      return call('restoreDefaultAgents', [])
    },
    saveSkill(skill) {
      return call('saveSkill', [skill])
    },
    deleteSkill(name) {
      return call('deleteSkill', [name])
    },
    importSkill(sourceDir, overwrite) {
      return call('importSkill', [sourceDir, overwrite])
    },
    getToolToggles() {
      return call('getToolToggles', [])
    },
    setSkillEnabled(name, enabled) {
      return call('setSkillEnabled', [name, enabled])
    },
    setToolGroupEnabled(group, enabled) {
      return call('setToolGroupEnabled', [group, enabled])
    },
    listToolGroups() {
      return call('listToolGroups', [])
    },
    listMemory(namespace) {
      return call('listMemory', [namespace])
    },
    getUsageStats(rangeDays) {
      return call('getUsageStats', [rangeDays])
    },
    listCronJobsForSession(sessionId) {
      return call('listCronJobsForSession', [sessionId])
    },
    listAllCronJobs() {
      return call('listAllCronJobs', [])
    },
    listAllCronRuns() {
      return call('listAllCronRuns', [])
    },
    async cancelCronJob(id) {
      await call('cancelCronJob', [id])
    },
  }
}
