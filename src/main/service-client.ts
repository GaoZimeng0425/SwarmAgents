import { createLogger } from '@shared/logger'
import type { BudgetConfig } from '@shared/types/budgets'
import type { McpServerConfig, McpServerStatus } from '@shared/types/mcp'
import type { MemoryView } from '@shared/types/memory'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod, ServiceToMain } from '@shared/types/service-ipc'
import type { AgentDefinition, AgentListItem, AgentMutationResult } from '@shared/types/agent'
import type { Skill, SkillMutationResult } from '@shared/types/skill'
import type { ToolGroupInfo, ToolToggles } from '@shared/types/tool-toggles'
import type { PermissionDecision } from '@shared/types/ui'
import type { WebSearchInjection } from '@shared/types/web-search'

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
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('@shared/types/task').Attachment[],
    options?: import('@shared/types/task').TaskOptions
  ): Promise<{ taskId: string }>
  listSessions(): Promise<import('@shared/types/ui').SessionSummary[]>
  getSessionTasks(sessionId: string): Promise<import('@shared/types/task').Task[]>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  updateSessionSettings(sessionId: string, settings: import('@shared/types/ui').SessionSettings): Promise<void>
  reorderSessions(orderedIds: string[]): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
  interruptWith(sessionId: string, taskId: string): Promise<void>
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): Promise<McpServerStatus[]>
  setWebSearchConfig(config: WebSearchInjection): Promise<void>
  setBudgetConfig(config: BudgetConfig): Promise<void>
  listSkills(): Promise<Skill[]>
  listAgents(): Promise<AgentListItem[]>
  saveAgent(def: AgentDefinition): Promise<AgentMutationResult>
  deleteAgent(id: string): Promise<AgentMutationResult>
  saveSkill(skill: Skill): Promise<SkillMutationResult>
  deleteSkill(name: string): Promise<SkillMutationResult>
  importSkill(sourceDir: string, overwrite?: boolean): Promise<SkillMutationResult>
  getToolToggles(): Promise<ToolToggles>
  setSkillEnabled(name: string, enabled: boolean): Promise<ToolToggles>
  setToolGroupEnabled(group: string, enabled: boolean): Promise<ToolToggles>
  listToolGroups(): Promise<ToolGroupInfo[]>
  listMemory(namespace?: string): Promise<MemoryView[]>
  getUsageStats(rangeDays: number): Promise<import('@shared/types/usage').UsageStats>
  listCronJobsForSession(sessionId: string): Promise<import('@shared/types/ui').CronJobSummary[]>
  listAllCronJobs(): Promise<import('@shared/types/ui').ScheduledTask[]>
  listAllCronRuns(): Promise<import('@shared/types/ui').CronRun[]>
  cancelCronJob(id: string): Promise<void>
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
    submitGoal(sessionId, goal, attachments, options) {
      return call('submitGoal', [sessionId, goal, attachments, options])
    },
    listSessions() {
      return call('listSessions', [])
    },
    getSessionTasks(sessionId) {
      return call('getSessionTasks', [sessionId])
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
    async cancelTask(sessionId, taskId) {
      await call('cancelTask', [sessionId, taskId])
    },
    async interruptWith(sessionId, taskId) {
      await call('interruptWith', [sessionId, taskId])
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
