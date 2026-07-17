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
  ProviderInjection,
  ServiceMethod,
  ServiceMethodSignatures,
  Skill,
  SkillMutationResult,
  ToolGroupInfo,
  ToolToggles,
  WebSearchInjection,
} from '@swarm/protocol'
import { serviceMethodArgSchemas } from '@swarm/protocol'

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

// One handler per table method; each body is compile-checked against the
// single-source signature (args AND result). Replaces the switch whose arms
// cast `args as [...]` blindly.
type ServiceHandlers = {
  [M in ServiceMethod]: (
    ...args: ServiceMethodSignatures[M]['args']
  ) => ServiceMethodSignatures[M]['result'] | Promise<ServiceMethodSignatures[M]['result']>
}

export function createDispatcher(cfg: DispatcherConfig): Dispatcher {
  const { service, registerProvider } = cfg
  const handlers: ServiceHandlers = {
    createSession: (provider) => {
      registerProvider(provider)
      return service.createSession(provider)
    },
    forkSession: (sourceSessionId, upToRowId) => service.forkSession(sourceSessionId, upToRowId),
    // Routes to SessionService.submitPrompt (entries-driven) and returns { runId }.
    submitPrompt: (sessionId, prompt, attachments, options) =>
      service.submitPrompt(sessionId, prompt, attachments, undefined, options),
    analyzeThread: (req) => cfg.analyzeThread(req),
    collectArticle: (input) => cfg.collectArticle(input),
    analyzeArticle: (req) => cfg.analyzeArticle(req),
    analyzeBilibili: (req) => cfg.analyzeBilibili(req),
    listArticles: () => cfg.listArticles(),
    getArticleAnalysis: (articleId) => cfg.getArticleAnalysis(articleId),
    deleteArticle: (articleId) => cfg.deleteArticle(articleId),
    researchRepo: (req) => cfg.researchRepo(req),
    getRepoResearch: (repoName) => cfg.getRepoResearch(repoName),
    researchedRepoNames: () => cfg.researchedRepoNames(),
    listSessions: () => service.listSessions(),
    getSessionEntries: (sessionId, afterRowId) => service.getSessionEntries(sessionId, afterRowId),
    exportSessionMarkdown: (sessionId) => service.exportSessionMarkdown(sessionId),
    deleteSession: (sessionId) => {
      service.deleteSession(sessionId)
      return { ok: true } as const
    },
    renameSession: (sessionId, title) => {
      service.renameSession(sessionId, title)
      return { ok: true } as const
    },
    setSessionPinned: (sessionId, pinned) => {
      service.setSessionPinned(sessionId, pinned)
      return { ok: true } as const
    },
    updateSessionSettings: (sessionId, settings) => {
      service.updateSessionSettings(sessionId, settings)
      return { ok: true } as const
    },
    reorderSessions: (orderedIds) => {
      service.reorderSessions(orderedIds)
      return { ok: true } as const
    },
    decidePermission: (sessionId, actionId, decision) => {
      service.resolvePermission(sessionId, actionId, decision)
      return { ok: true } as const
    },
    cancelRun: (sessionId) => {
      service.cancelRun(sessionId)
      return { ok: true } as const
    },
    setMcpServers: (configs) => cfg.setMcpServers(configs).then(() => ({ ok: true }) as const),
    getMcpStatus: () => cfg.getMcpStatus(),
    setWebSearchConfig: (config) => {
      cfg.setWebSearchConfig(config)
      return { ok: true } as const
    },
    setBudgetConfig: (config) => {
      cfg.setBudgetConfig(config)
      return { ok: true } as const
    },
    listSkills: () => cfg.listSkills(),
    listAgents: () => cfg.listAgents(),
    saveAgent: (def) => cfg.saveAgent(def),
    deleteAgent: (id) => cfg.deleteAgent(id),
    restoreDefaultAgents: () => cfg.restoreDefaultAgents(),
    saveSkill: (skill) => cfg.saveSkill(skill),
    deleteSkill: (name) => cfg.deleteSkill(name),
    importSkill: (sourceDir, overwrite) => cfg.importSkill(sourceDir, overwrite),
    getToolToggles: () => cfg.getToolToggles(),
    setSkillEnabled: (name, enabled) => cfg.setSkillEnabled(name, enabled),
    setToolGroupEnabled: (group, enabled) => cfg.setToolGroupEnabled(group, enabled),
    listToolGroups: () => cfg.listToolGroups(),
    listMemory: (namespace) => cfg.listMemory(namespace),
    getUsageStats: (rangeDays) => service.getUsageStats(rangeDays),
    listCronJobsForSession: (sessionId) => cfg.listCronJobsForSession(sessionId),
    listAllCronJobs: () => cfg.listAllCronJobs(),
    listAllCronRuns: () => cfg.listAllCronRuns(),
    cancelCronJob: (id) => {
      cfg.cancelCronJob(id)
      return { ok: true } as const
    },
  }

  return (method, args) => {
    if (!Object.hasOwn(serviceMethodArgSchemas, method)) throw new Error(`unknown method: ${String(method)}`)
    const schema = serviceMethodArgSchemas[method]
    // WS clients JSON.stringify their frames, turning omitted trailing
    // optionals (undefined) into null. No table method takes null as a
    // meaningful top-level arg, so normalize before validation; nested nulls
    // inside objects are governed by each schema.
    const normalized = args.map((a) => (a === null ? undefined : a))
    const parsed = schema.safeParse(normalized)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new Error(
        `invalid args for ${method}: ${issue ? `${issue.path.join('.') || '(root)'} ${issue.message}` : 'invalid'}`
      )
    }
    // Correlated-union call: TS cannot prove handlers[method] accepts
    // parsed.data for the same M — the single documented cast at the choke point.
    return (handlers[method] as (...a: unknown[]) => unknown)(...parsed.data)
  }
}
