// Pure request router. Maps a (method, args) RPC pair to a SessionManager
// call and returns a JSON-serialisable result. Replaces the URL/method
// matching that lived in the HTTP server. No transport, no I/O — trivially
// unit-testable.

import type { McpServerConfig, McpServerStatus } from '@shared/types/mcp'
import type { MemoryView } from '@shared/types/memory'
import type { ProviderInjection } from '@shared/types/provider'
import type { ServiceMethod } from '@shared/types/service-ipc'
import type { Skill, SkillMutationResult } from '@shared/types/skill'
import type { PermissionDecision } from '@shared/types/ui'

import type { SessionManager } from './session-manager'

type DispatcherConfig = {
  manager: SessionManager
  registerProvider(provider: ProviderInjection): void
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): McpServerStatus[]
  listSkills(): Skill[]
  saveSkill(skill: Skill): SkillMutationResult
  deleteSkill(name: string): SkillMutationResult
  listMemory(namespace?: string): MemoryView[]
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
        const [sessionId, goal, attachments] = args as [
          string,
          string,
          import('@shared/types/task').Attachment[] | undefined,
        ]
        return manager.submitGoal(sessionId, goal, attachments)
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
      case 'decidePermission': {
        const [sessionId, actionId, decision] = args as [string, string, PermissionDecision]
        manager.resolvePermission(sessionId, actionId, decision)
        return { ok: true }
      }
      case 'respondAsk': {
        const [sessionId, askId, answer] = args as [string, string, string]
        manager.resolveAsk(sessionId, askId, answer)
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
      case 'listMemory': {
        const [namespace] = args as [string | undefined]
        return cfg.listMemory(namespace)
      }
      default:
        throw new Error(`unknown method: ${String(method)}`)
    }
  }
}
