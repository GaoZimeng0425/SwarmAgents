import { createLogger } from '@shared/logger'
import type { BudgetConfig } from '@shared/types/budgets'
import type { McpServerConfig, McpServerStatus } from '@shared/types/mcp'
import type { MemoryView } from '@shared/types/memory'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod, ServiceToMain } from '@shared/types/service-ipc'
import type { Skill, SkillMutationResult } from '@shared/types/skill'
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
    attachments?: import('@shared/types/task').Attachment[]
  ): Promise<{ taskId: string }>
  listSessions(): Promise<import('@shared/types/ui').SessionSummary[]>
  getSessionTasks(sessionId: string): Promise<import('@shared/types/task').Task[]>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  reorderSessions(orderedIds: string[]): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  respondAsk(sessionId: string, askId: string, answer: string): Promise<void>
  cancelTask(sessionId: string, taskId: string): Promise<void>
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): Promise<McpServerStatus[]>
  setWebSearchConfig(config: WebSearchInjection): Promise<void>
  setBudgetConfig(config: BudgetConfig): Promise<void>
  listSkills(): Promise<Skill[]>
  saveSkill(skill: Skill): Promise<SkillMutationResult>
  deleteSkill(name: string): Promise<SkillMutationResult>
  listMemory(namespace?: string): Promise<MemoryView[]>
  getUsageStats(rangeDays: number): Promise<import('@shared/types/usage').UsageStats>
  listCronJobsForSession(sessionId: string): Promise<import('@shared/types/ui').CronJobSummary[]>
  listAllCronJobs(): Promise<import('@shared/types/ui').ScheduledTask[]>
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
    submitGoal(sessionId, goal, attachments) {
      return call('submitGoal', [sessionId, goal, attachments])
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
    async reorderSessions(orderedIds) {
      await call('reorderSessions', [orderedIds])
    },
    async decidePermission(sessionId, actionId, decision) {
      await call('decidePermission', [sessionId, actionId, decision])
    },
    async respondAsk(sessionId, askId, answer) {
      await call('respondAsk', [sessionId, askId, answer])
    },
    async cancelTask(sessionId, taskId) {
      await call('cancelTask', [sessionId, taskId])
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
    saveSkill(skill) {
      return call('saveSkill', [skill])
    },
    deleteSkill(name) {
      return call('deleteSkill', [name])
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
    async cancelCronJob(id) {
      await call('cancelCronJob', [id])
    },
  }
}
