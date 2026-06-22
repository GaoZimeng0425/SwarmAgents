// Pure request router. Maps a (method, args) RPC pair to a SessionManager
// call and returns a JSON-serialisable result. Replaces the URL/method
// matching that lived in the HTTP server. No transport, no I/O — trivially
// unit-testable.

import type { BudgetConfig } from '@shared/types/budgets'
import type { McpServerConfig, McpServerStatus } from '@shared/types/mcp'
import type { MemoryView } from '@shared/types/memory'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod } from '@shared/types/service-ipc'
import type { Skill, SkillMutationResult } from '@shared/types/skill'
import type { PermissionDecision } from '@shared/types/ui'
import type { WebSearchInjection } from '@shared/types/web-search'

import type { SessionManager } from './session-manager'

type DispatcherConfig = {
  manager: SessionManager
  registerProvider(provider: ProviderInjection): void
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): McpServerStatus[]
  setWebSearchConfig(config: WebSearchInjection): void
  setBudgetConfig(config: BudgetConfig): void
  listSkills(): Skill[]
  saveSkill(skill: Skill): SkillMutationResult
  deleteSkill(name: string): SkillMutationResult
  importSkill(sourceDir: string, overwrite?: boolean): SkillMutationResult
  listMemory(namespace?: string): MemoryView[]
  listCronJobsForSession(sessionId: string): import('@shared/types/ui').CronJobSummary[]
  listAllCronJobs(): import('@shared/types/ui').ScheduledTask[]
  cancelCronJob(id: string): void
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
        const [sessionId, goal, attachments, options] = args as [
          string,
          string,
          import('@shared/types/task').Attachment[] | undefined,
          import('@shared/types/task').TaskOptions | undefined,
        ]
        return manager.submitGoal(sessionId, goal, attachments, undefined, undefined, options)
      }
      case 'listSessions':
        return manager.listSessions()
      case 'getSessionTasks': {
        const [sessionId] = args as [string]
        return manager.getSessionTasks(sessionId)
      }
      case 'deleteSession': {
        const [sessionId] = args as [string]
        manager.deleteSession(sessionId)
        return { ok: true }
      }
      case 'renameSession': {
        const [sessionId, title] = args as [string, string]
        manager.renameSession(sessionId, title)
        return { ok: true }
      }
      case 'setSessionPinned': {
        const [sessionId, pinned] = args as [string, boolean]
        manager.setSessionPinned(sessionId, pinned)
        return { ok: true }
      }
      case 'reorderSessions': {
        const [orderedIds] = args as [string[]]
        manager.reorderSessions(orderedIds)
        return { ok: true }
      }
      case 'decidePermission': {
        const [sessionId, actionId, decision] = args as [string, string, PermissionDecision]
        manager.resolvePermission(sessionId, actionId, decision)
        return { ok: true }
      }
      case 'cancelTask': {
        const [sessionId, taskId] = args as [string, string]
        manager.cancelTask(sessionId, taskId)
        return { ok: true }
      }
      case 'setMcpServers': {
        const [configs] = args as [McpServerConfig[]]
        return cfg.setMcpServers(configs).then(() => ({ ok: true }))
      }
      case 'getMcpStatus':
        return cfg.getMcpStatus()
      case 'setWebSearchConfig': {
        const [config] = args as [WebSearchInjection]
        cfg.setWebSearchConfig(config)
        return { ok: true }
      }
      case 'setBudgetConfig': {
        const [config] = args as [BudgetConfig]
        cfg.setBudgetConfig(config)
        return { ok: true }
      }
      case 'listSkills':
        return cfg.listSkills()
      case 'saveSkill': {
        const [skill] = args as [Skill]
        return cfg.saveSkill(skill)
      }
      case 'deleteSkill': {
        const [name] = args as [string]
        return cfg.deleteSkill(name)
      }
      case 'importSkill': {
        const [sourceDir, overwrite] = args as [string, boolean | undefined]
        return cfg.importSkill(sourceDir, overwrite)
      }
      case 'listMemory': {
        const [namespace] = args as [string | undefined]
        return cfg.listMemory(namespace)
      }
      case 'getUsageStats': {
        const [rangeDays] = args as [number]
        return manager.getUsageStats(rangeDays)
      }
      case 'listCronJobsForSession': {
        const [sessionId] = args as [string]
        return cfg.listCronJobsForSession(sessionId)
      }
      case 'listAllCronJobs':
        return cfg.listAllCronJobs()
      case 'cancelCronJob': {
        const [id] = args as [string]
        cfg.cancelCronJob(id)
        return { ok: true }
      }
      default:
        throw new Error(`unknown method: ${String(method)}`)
    }
  }
}
