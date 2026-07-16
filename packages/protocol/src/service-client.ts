import { createRpcPeer, type RpcTransport } from './rpc-peer'
import type { AgentDefinition, AgentListItem, AgentMutationResult } from './types/agent'
import type {
  AnalyzeArticleRequest,
  AnalyzeArticleResult,
  ArticleSource,
  ArticleSummary,
  CollectArticleResult,
  CollectedArticleWithAnalysis,
} from './types/article'
import type { AnalyzeBilibiliRequest, AnalyzeBilibiliResult } from './types/bilibili'
import type { BudgetConfig } from './types/budgets'
import type { McpServerConfig, McpServerStatus } from './types/mcp'
import type { MemoryView } from './types/memory'
import type { ProviderInjection } from './types/provider'
import type { MainMethod } from './types/service-ipc'
import type { Skill, SkillMutationResult } from './types/skill'
import type { ToolGroupInfo, ToolToggles } from './types/tool-toggles'
import type { RepoResearch, ResearchRepoRequest, ResearchRepoResult } from './types/trending'
import type { PermissionDecision } from './types/ui'
import type { WebSearchInjection } from './types/web-search'

// Kept as an alias so existing imports of ServiceTransport (desktop main,
// extension, RN) don't need to change.
export type ServiceTransport = RpcTransport

export type ServiceClient = {
  connect(): Promise<void>
  disconnect(): void
  createSession(provider: ProviderInjection): Promise<{ sessionId: string }>
  forkSession(sourceSessionId: string, upToRowId: number): Promise<{ sessionId: string }>
  submitPrompt(
    sessionId: string,
    prompt: string,
    attachments?: import('./types/task').Attachment[],
    options?: import('./types/task').RunOptions
  ): Promise<{ runId: string }>
  analyzeThread(req: import('./types/ui').AnalyzeThreadRequest): Promise<import('./types/ui').AnalyzeThreadResult>
  collectArticle(input: ArticleSource): Promise<CollectArticleResult>
  analyzeArticle(req: AnalyzeArticleRequest): Promise<AnalyzeArticleResult>
  analyzeBilibili(req: AnalyzeBilibiliRequest): Promise<AnalyzeBilibiliResult>
  listArticles(): Promise<CollectedArticleWithAnalysis[]>
  getArticleAnalysis(articleId: string): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>
  deleteArticle(articleId: string): Promise<void>
  researchRepo(req: ResearchRepoRequest): Promise<ResearchRepoResult>
  getRepoResearch(repoName: string): Promise<{ research: RepoResearch | null; researchedAt: string | null }>
  researchedRepoNames(): Promise<string[]>
  listSessions(): Promise<import('./types/ui').SessionSummary[]>
  getSessionEntries(sessionId: string, afterRowId?: number): Promise<import('./types/session-entry').EntryRow[]>
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  setSessionPinned(sessionId: string, pinned: boolean): Promise<void>
  updateSessionSettings(sessionId: string, settings: import('./types/ui').SessionSettings): Promise<void>
  reorderSessions(orderedIds: string[]): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  cancelRun(sessionId: string): Promise<void>
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
  // Registers a handler this side can serve for the other side's call() — e.g.
  // main registers 'weather.get_forecast' so the service process can call it.
  // Renamed from the old registerMainRpc: with one symmetric request/response
  // pair there's no "main-specific" RPC anymore, just "a handler this
  // instance can serve."
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown> | unknown): void
}

export function createServiceClient(cfg: {
  transport: ServiceTransport
  onEvent?: (event: string, data: unknown) => void
}): ServiceClient {
  const peer = createRpcPeer({
    transport: cfg.transport,
    onEvent: cfg.onEvent,
    // A request for a method nobody registered still gets an error response
    // (RpcPeer would do that on its own), but warn here first so the miss is
    // visible in this side's logs — a silent wrong-side dispatch is exactly
    // the bug class that made get_weather fall back to wttr.in. console, not
    // pino: @swarm/protocol stays logger-free for portability.
    defaultHandler: (method, _args, id) => {
      console.warn({ msg: 'no rpc handler', method, id })
      throw new Error(`no handler for ${method}`)
    },
  })

  return {
    connect: () => peer.connect(),
    disconnect: () => peer.disconnect(),
    registerHandler: (method, fn) => peer.registerHandler(method, fn),
    createSession: (provider) => peer.call('createSession', [provider]),
    forkSession: (sourceSessionId, upToRowId) => peer.call('forkSession', [sourceSessionId, upToRowId]),
    submitPrompt: (sessionId, prompt, attachments, options) =>
      peer.call('submitPrompt', [sessionId, prompt, attachments, options]),
    analyzeThread: (req) => peer.call('analyzeThread', [req]),
    collectArticle: (input) => peer.call('collectArticle', [input]),
    analyzeArticle: (req) => peer.call('analyzeArticle', [req]),
    analyzeBilibili: (req) => peer.call('analyzeBilibili', [req]),
    listArticles: () => peer.call('listArticles', []),
    getArticleAnalysis: (articleId) => peer.call('getArticleAnalysis', [articleId]),
    async deleteArticle(articleId) {
      await peer.call('deleteArticle', [articleId])
    },
    researchRepo: (req) => peer.call('researchRepo', [req]),
    getRepoResearch: (repoName) => peer.call('getRepoResearch', [repoName]),
    researchedRepoNames: () => peer.call('researchedRepoNames', []),
    listSessions: () => peer.call('listSessions', []),
    getSessionEntries: (sessionId, afterRowId) => peer.call('getSessionEntries', [sessionId, afterRowId]),
    exportSessionMarkdown: (sessionId) => peer.call('exportSessionMarkdown', [sessionId]),
    async deleteSession(sessionId) {
      await peer.call('deleteSession', [sessionId])
    },
    async renameSession(sessionId, title) {
      await peer.call('renameSession', [sessionId, title])
    },
    async setSessionPinned(sessionId, pinned) {
      await peer.call('setSessionPinned', [sessionId, pinned])
    },
    async updateSessionSettings(sessionId, settings) {
      await peer.call('updateSessionSettings', [sessionId, settings])
    },
    async reorderSessions(orderedIds) {
      await peer.call('reorderSessions', [orderedIds])
    },
    async decidePermission(sessionId, actionId, decision) {
      await peer.call('decidePermission', [sessionId, actionId, decision])
    },
    async cancelRun(sessionId) {
      await peer.call('cancelRun', [sessionId])
    },
    async setMcpServers(configs) {
      await peer.call('setMcpServers', [configs])
    },
    getMcpStatus: () => peer.call('getMcpStatus', []),
    async setWebSearchConfig(config) {
      await peer.call('setWebSearchConfig', [config])
    },
    async setBudgetConfig(config) {
      await peer.call('setBudgetConfig', [config])
    },
    listSkills: () => peer.call('listSkills', []),
    listAgents: () => peer.call('listAgents', []),
    saveAgent: (def) => peer.call('saveAgent', [def]),
    deleteAgent: (id) => peer.call('deleteAgent', [id]),
    restoreDefaultAgents: () => peer.call('restoreDefaultAgents', []),
    saveSkill: (skill) => peer.call('saveSkill', [skill]),
    deleteSkill: (name) => peer.call('deleteSkill', [name]),
    importSkill: (sourceDir, overwrite) => peer.call('importSkill', [sourceDir, overwrite]),
    getToolToggles: () => peer.call('getToolToggles', []),
    setSkillEnabled: (name, enabled) => peer.call('setSkillEnabled', [name, enabled]),
    setToolGroupEnabled: (group, enabled) => peer.call('setToolGroupEnabled', [group, enabled]),
    listToolGroups: () => peer.call('listToolGroups', []),
    listMemory: (namespace) => peer.call('listMemory', [namespace]),
    getUsageStats: (rangeDays) => peer.call('getUsageStats', [rangeDays]),
    listCronJobsForSession: (sessionId) => peer.call('listCronJobsForSession', [sessionId]),
    listAllCronJobs: () => peer.call('listAllCronJobs', []),
    listAllCronRuns: () => peer.call('listAllCronRuns', []),
    async cancelCronJob(id) {
      await peer.call('cancelCronJob', [id])
    },
  }
}
