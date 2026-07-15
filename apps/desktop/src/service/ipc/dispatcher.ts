// Pure request router. Maps a (method, args) RPC pair to a SessionService
// call and returns a JSON-serialisable result. Replaces the URL/method
// matching that lived in the HTTP server. No transport, no I/O — trivially
// unit-testable.

import type {
  AgentDefinition,
  AgentListItem,
  AgentMutationResult,
  BudgetConfig,
  McpServerConfig,
  McpServerStatus,
  MemoryView,
  PermissionDecision,
  ProviderInjection,
  ServiceMethod,
  Skill,
  SkillMutationResult,
  ToolGroupInfo,
  ToolToggles,
  WebSearchInjection,
} from '@swarm/protocol'

import type { SessionService } from '../session/session-service'

type DispatcherConfig = {
  service: SessionService
  analyzeThread(req: import('@swarm/protocol').AnalyzeThreadRequest): import('@swarm/protocol').AnalyzeThreadResult
  collectArticle(input: import('@swarm/protocol').ArticleSource): import('@swarm/protocol').CollectArticleResult
  analyzeArticle(req: import('@swarm/protocol').AnalyzeArticleRequest): import('@swarm/protocol').AnalyzeArticleResult
  analyzeBilibili(
    req: import('@swarm/protocol').AnalyzeBilibiliRequest
  ): import('@swarm/protocol').AnalyzeBilibiliResult
  listArticles(): Promise<import('@swarm/protocol').CollectedArticleWithAnalysis[]>
  getArticleAnalysis(
    articleId: string
  ): Promise<{ summary: import('@swarm/protocol').ArticleSummary | null; analyzedAt: string | null }>
  deleteArticle(articleId: string): Promise<void>
  researchRepo(req: import('@swarm/protocol').ResearchRepoRequest): import('@swarm/protocol').ResearchRepoResult
  getRepoResearch(
    repoName: string
  ): Promise<{ research: import('@swarm/protocol').RepoResearch | null; researchedAt: string | null }>
  researchedRepoNames(): Promise<string[]>
  registerProvider(provider: ProviderInjection): void
  setMcpServers(configs: McpServerConfig[]): Promise<void>
  getMcpStatus(): McpServerStatus[]
  setWebSearchConfig(config: WebSearchInjection): void
  setBudgetConfig(config: BudgetConfig): void
  listSkills(): Skill[]
  listAgents(): AgentListItem[]
  saveAgent(def: AgentDefinition): AgentMutationResult
  deleteAgent(id: string): AgentMutationResult
  restoreDefaultAgents(): AgentMutationResult
  saveSkill(skill: Skill): SkillMutationResult
  deleteSkill(name: string): SkillMutationResult
  importSkill(sourceDir: string, overwrite?: boolean): SkillMutationResult
  getToolToggles(): ToolToggles
  setSkillEnabled(name: string, enabled: boolean): ToolToggles
  setToolGroupEnabled(group: string, enabled: boolean): ToolToggles
  listToolGroups(): ToolGroupInfo[]
  listMemory(namespace?: string): MemoryView[]
  listCronJobsForSession(sessionId: string): import('@swarm/protocol').CronJobSummary[]
  listAllCronJobs(): import('@swarm/protocol').ScheduledTask[]
  listAllCronRuns(): import('@swarm/protocol').CronRun[]
  cancelCronJob(id: string): void
}

export type Dispatcher = (method: ServiceMethod, args: unknown[]) => unknown

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const { service, registerProvider } = cfg
  return (method, args) => {
    switch (method) {
      case 'createSession': {
        const [provider] = args as [ProviderInjection]
        registerProvider(provider)
        return service.createSession(provider)
      }
      case 'forkToNewSession': {
        const [sourceSessionId, forkPointMessageId, newPrompt, opts] = args as [
          string,
          string,
          string,
          { agentType?: string } | undefined,
        ]
        return service.forkToNewSession(sourceSessionId, forkPointMessageId, newPrompt, opts)
      }
      case 'submitPrompt': {
        // The method name stays (ServiceMethod stability for the renderer API),
        // but the call maps to SessionService.submitPrompt and returns { messageId }.
        const [sessionId, prompt, attachments, options] = args as [
          string,
          string,
          import('@swarm/protocol').Attachment[] | undefined,
          import('@swarm/protocol').RunOptions | undefined,
        ]
        return service.submitPrompt(sessionId, prompt, attachments, undefined, options)
      }
      case 'analyzeThread': {
        const [req] = args as [import('@swarm/protocol').AnalyzeThreadRequest]
        return cfg.analyzeThread(req)
      }
      case 'collectArticle': {
        const [input] = args as [import('@swarm/protocol').ArticleSource]
        return cfg.collectArticle(input)
      }
      case 'analyzeArticle': {
        const [req] = args as [import('@swarm/protocol').AnalyzeArticleRequest]
        return cfg.analyzeArticle(req)
      }
      case 'analyzeBilibili': {
        const [req] = args as [import('@swarm/protocol').AnalyzeBilibiliRequest]
        return cfg.analyzeBilibili(req)
      }
      case 'listArticles': {
        return cfg.listArticles()
      }
      case 'getArticleAnalysis': {
        const [articleId] = args as [string]
        return cfg.getArticleAnalysis(articleId)
      }
      case 'deleteArticle': {
        const [articleId] = args as [string]
        return cfg.deleteArticle(articleId)
      }
      case 'researchRepo': {
        const [req] = args as [import('@swarm/protocol').ResearchRepoRequest]
        return cfg.researchRepo(req)
      }
      case 'getRepoResearch': {
        const [repoName] = args as [string]
        return cfg.getRepoResearch(repoName)
      }
      case 'researchedRepoNames':
        return cfg.researchedRepoNames()
      case 'listSessions':
        return service.listSessions()
      case 'getMessageEvents': {
        const [sessionId] = args as [string]
        return service.getMessageEvents(sessionId)
      }
      case 'exportSessionMarkdown': {
        const [sessionId] = args as [string]
        return service.exportSessionMarkdown(sessionId)
      }
      case 'deleteSession': {
        const [sessionId] = args as [string]
        service.deleteSession(sessionId)
        return { ok: true }
      }
      case 'renameSession': {
        const [sessionId, title] = args as [string, string]
        service.renameSession(sessionId, title)
        return { ok: true }
      }
      case 'setSessionPinned': {
        const [sessionId, pinned] = args as [string, boolean]
        service.setSessionPinned(sessionId, pinned)
        return { ok: true }
      }
      case 'updateSessionSettings': {
        const [sessionId, settings] = args as [string, import('@swarm/protocol').SessionSettings]
        service.updateSessionSettings(sessionId, settings)
        return { ok: true }
      }
      case 'reorderSessions': {
        const [orderedIds] = args as [string[]]
        service.reorderSessions(orderedIds)
        return { ok: true }
      }
      case 'decidePermission': {
        const [sessionId, actionId, decision] = args as [string, string, PermissionDecision]
        service.resolvePermission(sessionId, actionId, decision)
        return { ok: true }
      }
      case 'cancelMessage': {
        const [sessionId, messageId] = args as [string, string]
        service.cancelMessage(sessionId, messageId)
        return { ok: true }
      }
      case 'promoteQueuedMessage': {
        const [sessionId, taskId] = args as [string, string]
        service.promoteQueuedMessage(sessionId, taskId)
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
      case 'listAgents':
        return cfg.listAgents()
      case 'saveSkill': {
        const [skill] = args as [Skill]
        return cfg.saveSkill(skill)
      }
      case 'deleteSkill': {
        const [name] = args as [string]
        return cfg.deleteSkill(name)
      }
      case 'saveAgent': {
        const [def] = args as [AgentDefinition]
        return cfg.saveAgent(def)
      }
      case 'deleteAgent': {
        const [id] = args as [string]
        return cfg.deleteAgent(id)
      }
      case 'restoreDefaultAgents':
        return cfg.restoreDefaultAgents()
      case 'importSkill': {
        const [sourceDir, overwrite] = args as [string, boolean | undefined]
        return cfg.importSkill(sourceDir, overwrite)
      }
      case 'getToolToggles':
        return cfg.getToolToggles()
      case 'setSkillEnabled': {
        const [name, enabled] = args as [string, boolean]
        return cfg.setSkillEnabled(name, enabled)
      }
      case 'setToolGroupEnabled': {
        const [group, enabled] = args as [string, boolean]
        return cfg.setToolGroupEnabled(group, enabled)
      }
      case 'listToolGroups':
        return cfg.listToolGroups()
      case 'listMemory': {
        const [namespace] = args as [string | undefined]
        return cfg.listMemory(namespace)
      }
      case 'getUsageStats': {
        const [rangeDays] = args as [number]
        return service.getUsageStats(rangeDays)
      }
      case 'listCronJobsForSession': {
        const [sessionId] = args as [string]
        return cfg.listCronJobsForSession(sessionId)
      }
      case 'listAllCronJobs':
        return cfg.listAllCronJobs()
      case 'listAllCronRuns':
        return cfg.listAllCronRuns()
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
