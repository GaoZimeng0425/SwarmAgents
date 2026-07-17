// Single source of truth for the renderer->main IPC surface (desktop only).
// Type-only: no runtime values. Channel strings are frozen — they must match
// the literals in preload/index.ts and the main-process handle sites verbatim.
// Growth rule: each migration plan appends its domain's entries; a channel
// appears here if and only if a typed consumer (preload invoke / registrar
// handle) uses it.
import type { ServiceMethod, ServiceMethodSignatures } from './service-methods'
import type { AnalyzeArticleResult } from './types/article'
import type {
  BiliAnalysis,
  BiliDeleteResult,
  BiliListResult,
  BiliLoginStatus,
  BiliProcessResult,
  BiliSaveResult,
  BiliSummary,
  BiliTranscribeProgress,
  BiliTranscribeResult,
  BiliVideo,
  ObsidianConfig,
  TranscriptionConfig,
} from './types/bilibili'
import type { BudgetConfig } from './types/budgets'
import type { CalendarConfigView } from './types/calendar'
import type { GmailConfigView } from './types/gmail'
import type { McpMutationResult, McpServerConfig, McpServerStatus, McpToolOverride } from './types/mcp'
import type { ApiStyle, ModelThinkingLevel, ProvidersStateView } from './types/provider'
import type { SkillMutationResult } from './types/skill'
import type { ResearchRepoResult, TrendingPeriod, TrendingRepo } from './types/trending'
import type {
  AddCustomProviderInput,
  AnalyzeThreadInput,
  AnalyzeThreadResult,
  ArtifactEntry,
  BudgetsSetResult,
  MacPermissions,
  PermissionDecision,
  ProvidersAddResult,
  ProvidersFetchModelInfoResult,
  ProvidersSetResult,
  ProvidersTestResult,
  UIEvent,
  WebSearchKeyId,
  WebSearchSetResult,
} from './types/ui'
import type { WeatherForecast } from './types/weather'
import type { WebSearchConfigView, WebSearchProviderId } from './types/web-search'
import type { WorkbenchData } from './types/workbench'

// A channel that forwards verbatim to the service: same args, same result.
// Service signature changes propagate here without touching this file.
type Passthrough<M extends ServiceMethod> = ServiceMethodSignatures[M]

export type RendererIpcSignatures = {
  // ---- ipc/swarm-ipc.ts ----
  'mcp:getStatus': Passthrough<'getMcpStatus'>
  'skills:list': Passthrough<'listSkills'>
  'agents:list': Passthrough<'listAgents'>
  'skills:save': Passthrough<'saveSkill'>
  'skills:delete': Passthrough<'deleteSkill'>
  'agents:save': Passthrough<'saveAgent'>
  'agents:delete': Passthrough<'deleteAgent'>
  'agents:restore-defaults': Passthrough<'restoreDefaultAgents'>
  // Dialog flow when sourceDir is absent; echoes sourceDir on a name clash.
  'skills:import': {
    args: [{ sourceDir?: string; overwrite?: boolean }?]
    result: SkillMutationResult | { ok: false; code: 'cancelled' | 'exists'; message: string; sourceDir?: string }
  }
  'memory:list': Passthrough<'listMemory'>
  'toolToggles:get': Passthrough<'getToolToggles'>
  'toolToggles:setSkill': Passthrough<'setSkillEnabled'>
  'toolToggles:setToolGroup': Passthrough<'setToolGroupEnabled'>
  'tools:listGroups': Passthrough<'listToolGroups'>
  'swarm:createSession': { args: []; result: { sessionId: string } } // main injects provider
  'swarm:forkSession': Passthrough<'forkSession'>
  'swarm:analyzeThread': { args: [AnalyzeThreadInput]; result: AnalyzeThreadResult } // main injects provider
  'swarm:listSessions': Passthrough<'listSessions'>
  'swarm:getSessionEntries': Passthrough<'getSessionEntries'>
  'swarm:getUsageStats': Passthrough<'getUsageStats'>
  'swarm:deleteSession': Passthrough<'deleteSession'>
  'swarm:renameSession': Passthrough<'renameSession'>
  'swarm:setSessionPinned': Passthrough<'setSessionPinned'>
  'swarm:updateSessionSettings': Passthrough<'updateSessionSettings'>
  'swarm:reorderSessions': Passthrough<'reorderSessions'>
  'swarm:submitPrompt': Passthrough<'submitPrompt'>
  // Main catches serviceClient errors and resolves void (fire-and-forget).
  'swarm:cancelRun': { args: [string]; result: void }
  'swarm:decidePermission': { args: [string, string, PermissionDecision]; result: void }
  'swarm:listCronJobsForSession': Passthrough<'listCronJobsForSession'>
  'swarm:listAllCronJobs': Passthrough<'listAllCronJobs'>
  'swarm:listAllCronRuns': Passthrough<'listAllCronRuns'>
  'swarm:cancelCronJob': Passthrough<'cancelCronJob'>
  'swarm:exportSessionMarkdown': Passthrough<'exportSessionMarkdown'>
  'swarm:listArtifacts': { args: [{ query?: string; limit?: number }?]; result: ArtifactEntry[] }
  // ---- system (ipc/swarm-ipc.ts + index.ts) ----
  'system:getAccent': { args: []; result: string | null }
  'system:readImageFile': { args: [string]; result: { mimeType: string; data: string } | null }
  'system:readDocumentFile': { args: [string]; result: { mediaType: string; data: string } | null }
  'system:openPath': { args: [string]; result: void }
  'system:openUserDataDir': { args: []; result: void }
  'system:pickPath': { args: ['directory' | 'file']; result: string | null }
  'system:listDir': { args: [string, string?]; result: { name: string; isDir: boolean }[] }
  'system:getMacPermissions': { args: []; result: MacPermissions }
  'system:openPrivacySettings': { args: ['screen' | 'accessibility']; result: void }
  'system:getWsHostConfig': { args: []; result: { port: number; token: string; lanIp: string | null } | null }
  // ---- ipc/article-ipc.ts ----
  'swarm:article:list': Passthrough<'listArticles'>
  'swarm:article:analyze': { args: [string]; result: AnalyzeArticleResult } // main injects provider
  'swarm:article:getAnalysis': Passthrough<'getArticleAnalysis'>
  'swarm:article:delete': Passthrough<'deleteArticle'>
  // ---- trending/ipc.ts ----
  'trending:get': { args: [TrendingPeriod, string]; result: TrendingRepo[] }
  'trending:research': { args: [TrendingRepo, TrendingPeriod]; result: ResearchRepoResult } // main injects provider
  'trending:getResearch': Passthrough<'getRepoResearch'>
  'trending:researchedNames': Passthrough<'researchedRepoNames'>
  // ---- quick-panel/ipc.ts ----
  'swarm:quickPanel:hide': { args: []; result: void }
  'swarm:quickPanel:focusMain': { args: [{ navigate?: string; settings?: string }]; result: void }
  'swarm:quickPanel:getHotkey': { args: []; result: string }
  'swarm:quickPanel:setHotkey': { args: [string]; result: { ok: boolean } }
  // ---- system/deep-link.ts ----
  'swarm:consumePendingDeepLink': { args: []; result: { sessionId: string } | null }
  // ---- bilibili/ipc.ts (24 channels) ----
  'bilibili:status': { args: []; result: BiliLoginStatus }
  'bilibili:login': { args: []; result: BiliLoginStatus }
  'bilibili:logout': { args: []; result: void }
  'bilibili:list': { args: []; result: BiliListResult }
  'bilibili:process': { args: [string]; result: BiliProcessResult }
  'bilibili:open': { args: [string]; result: void }
  'bilibili:getObsidianConfig': { args: []; result: ObsidianConfig | null }
  'bilibili:setObsidianConfig': { args: [ObsidianConfig]; result: void }
  'bilibili:pickVault': { args: []; result: string | null }
  // save takes the full video + summary (fav deletion needs the fav* ids carried on BiliVideo)
  'bilibili:save': { args: [BiliVideo, BiliSummary]; result: BiliSaveResult }
  'bilibili:getTranscribeConfig': { args: []; result: TranscriptionConfig | null }
  'bilibili:setTranscribeConfig': { args: [TranscriptionConfig]; result: void }
  'bilibili:pickModelDir': { args: []; result: string | null }
  'bilibili:transcribe': { args: [string]; result: BiliTranscribeResult }
  'bilibili:analyzedBvids': { args: []; result: string[] }
  'bilibili:getAnalysis': { args: [string]; result: BiliAnalysis | null }
  'bilibili:deleteWatchLater': { args: [string]; result: BiliDeleteResult }
  'bilibili:deleteFav': { args: [BiliVideo]; result: BiliDeleteResult }
  'bilibili:archiveList': { args: []; result: BiliVideo[] }
  'bilibili:archivePut': { args: [BiliVideo]; result: void }
  'bilibili:archiveRemove': { args: [string]; result: void }
  'bilibili:pinsList': { args: []; result: BiliVideo[] }
  'bilibili:pinsPut': { args: [BiliVideo]; result: void }
  'bilibili:pinsRemove': { args: [string]; result: void }
  // ---- providers/ipc.ts (17 channels) ----
  'providers:get': { args: []; result: ProvidersStateView }
  'providers:setKey': { args: [string, string]; result: ProvidersSetResult }
  'providers:clearKey': { args: [string]; result: ProvidersSetResult }
  'providers:setActive': { args: [string | null]; result: ProvidersSetResult }
  'providers:setModel': { args: [string, string]; result: ProvidersSetResult }
  'providers:addCustomModel': { args: [string, string]; result: ProvidersSetResult }
  'providers:removeCustomModel': { args: [string, string]; result: ProvidersSetResult }
  'providers:setApiStyle': { args: [string, ApiStyle]; result: ProvidersSetResult }
  'providers:setThinkingLevel': { args: [string, ModelThinkingLevel]; result: ProvidersSetResult }
  'providers:setFallbackProviderIds': { args: [string, string[]]; result: ProvidersSetResult }
  'providers:setModelContextWindow': { args: [string, string, number | null]; result: ProvidersSetResult }
  'providers:fetchModelInfo': { args: [string]; result: ProvidersFetchModelInfoResult }
  'providers:setBaseUrl': { args: [string, string | null]; result: ProvidersSetResult }
  'providers:addCustomProvider': { args: [AddCustomProviderInput]; result: ProvidersAddResult }
  'providers:removeCustomProvider': { args: [string]; result: ProvidersSetResult }
  'providers:renameCustomProvider': { args: [string, string]; result: ProvidersSetResult }
  'providers:test': { args: [string]; result: ProvidersTestResult }
  // ---- mcp-servers/ipc.ts (6 channels; getStatus migrated in Plan 1 via swarm-ipc) ----
  'mcp:list': { args: []; result: McpServerConfig[] }
  'mcp:add': { args: [Omit<McpServerConfig, 'id'>]; result: McpMutationResult & { id?: string } }
  'mcp:update': { args: [string, Partial<Omit<McpServerConfig, 'id'>>]; result: McpMutationResult }
  'mcp:remove': { args: [string]; result: McpMutationResult }
  'mcp:setEnabled': { args: [string, boolean]; result: McpMutationResult }
  'mcp:setToolOverride': { args: [string, string, McpToolOverride | null]; result: McpMutationResult }
  // ---- web-search/ipc.ts (5 channels) ----
  'webSearch:get': { args: []; result: WebSearchConfigView }
  'webSearch:setProvider': { args: [WebSearchProviderId]; result: WebSearchSetResult }
  'webSearch:setKey': { args: [WebSearchKeyId, string]; result: WebSearchSetResult }
  'webSearch:clearKey': { args: [WebSearchKeyId]; result: WebSearchSetResult }
  'webSearch:setSearxngUrl': { args: [string | null]; result: WebSearchSetResult }
  // ---- budgets/ipc.ts (2 channels) ----
  'budgets:get': { args: []; result: BudgetConfig }
  'budgets:set': { args: [BudgetConfig]; result: BudgetsSetResult }
}
export type RendererIpcChannel = keyof RendererIpcSignatures

// All 15 event channels (spec §4 + inventory Events table). The *_CHANNEL
// const literals and payload types are transcribed from the Task 1 inventory
// doc (docs/superpowers/specs/2026-07-17-renderer-ipc-channel-inventory.md).
export type RendererIpcEvents = {
  'swarm:event': UIEvent
  'mcp:status': McpServerStatus[]
  'system:accentChange': { hex: string }
  'swarm:navigate': { sessionId?: string; route?: string }
  'swarm:navigate-settings': { route: string }
  'bilibili:transcribe:progress': BiliTranscribeProgress
  'gmail:stateChanged': GmailConfigView
  'calendar:stateChanged': CalendarConfigView
  'providers:stateChanged': ProvidersStateView
  'mcp:configChanged': McpServerConfig[]
  'webSearch:stateChanged': WebSearchConfigView
  'weather:forecastChanged': WeatherForecast
  'budgets:stateChanged': BudgetConfig
  'workbench:stateChanged': WorkbenchData
  // Orphan today: broadcast from system/auto-update.ts on 'update-downloaded'
  // with no payload arg, but no preload subscriber exists yet (see inventory
  // "Dead event"). Typed here so the Plan-3 closure can wire its sender.
  'system:updateReady': void
}
export type RendererIpcEventChannel = keyof RendererIpcEvents
