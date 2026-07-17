// Single source of truth for the renderer->main IPC surface (desktop only).
// Type-only: no runtime values. Channel strings are frozen — they must match
// the literals in preload/index.ts and the main-process handle sites verbatim.
// Growth rule: each migration plan appends its domain's entries; a channel
// appears here if and only if a typed consumer (preload invoke / registrar
// handle) uses it.
import type { ServiceMethod, ServiceMethodSignatures } from './service-methods'
import type { AnalyzeArticleResult } from './types/article'
import type { BiliTranscribeProgress } from './types/bilibili'
import type { BudgetConfig } from './types/budgets'
import type { CalendarConfigView } from './types/calendar'
import type { GmailConfigView } from './types/gmail'
import type { McpServerConfig, McpServerStatus } from './types/mcp'
import type { ProvidersStateView } from './types/provider'
import type { SkillMutationResult } from './types/skill'
import type { ResearchRepoResult, TrendingPeriod, TrendingRepo } from './types/trending'
import type {
  AnalyzeThreadInput,
  AnalyzeThreadResult,
  ArtifactEntry,
  MacPermissions,
  PermissionDecision,
  UIEvent,
} from './types/ui'
import type { WeatherForecast } from './types/weather'
import type { WebSearchConfigView } from './types/web-search'
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
