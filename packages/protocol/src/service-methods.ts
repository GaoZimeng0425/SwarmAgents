// Single source of truth for the main<->service RPC method table (both
// directions). ServiceClient and the service dispatcher are DERIVED from the
// artifacts here: adding a method means adding a signature + a schema entry —
// a missing or mismatched entry on either side is a compile error.
//
// One-way import rule: this file imports from ./types/*; no types/* file may
// import this one (prevents runtime cycles — the unions in types/service-ipc.ts
// are re-exports FROM here).
import { z } from 'zod'

import type { AgentDefinition, AgentListItem, AgentMutationResult } from './types/agent'
import { AgentDefinitionSchema } from './types/agent'
import type {
  AnalyzeArticleResult,
  ArticleSummary,
  CollectArticleResult,
  CollectedArticleWithAnalysis,
} from './types/article'
import { AnalyzeArticleRequest, ArticleSource } from './types/article'
import type { Attachment } from './types/artifact'
import { AttachmentSchema } from './types/artifact'
import type { AnalyzeBilibiliRequest, AnalyzeBilibiliResult } from './types/bilibili'
import type { BudgetConfig } from './types/budgets'
import { BudgetConfigSchema } from './types/budgets'
import type { SubmitOptions } from './types/execution'
import { ExecutionModeSchema, PermissionModeSchema, SubmitOptionsSchema } from './types/execution'
import type { McpServerConfig, McpServerStatus } from './types/mcp'
import { McpServerConfigSchema } from './types/mcp'
import type { MemoryView } from './types/memory'
import { ProviderInjection } from './types/provider'
import type { EntryRow } from './types/session-entry'
import type { Skill, SkillMutationResult } from './types/skill'
import { SkillSchema } from './types/skill'
import type { ToolGroupInfo, ToolToggles } from './types/tool-toggles'
import type { RepoResearch, ResearchRepoResult } from './types/trending'
import { ResearchRepoRequest } from './types/trending'
import type {
  AnalyzeThreadRequest,
  AnalyzeThreadResult,
  CalendarLocalInput,
  CronJobSummary,
  CronRun,
  PermissionDecision,
  ScheduledTask,
  SessionSettings,
  SessionSummary,
  ThreadAnalysisPayload,
} from './types/ui'
import type { UsageStats } from './types/usage'
import { WebSearchInjection } from './types/web-search'

// ---- schemas for types/ui.ts types that are type-only today --------------
// Defined here (not in types/ui.ts) to keep the one-way import rule.

const SessionSettingsSchema = z.object({
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  executionMode: ExecutionModeSchema.optional(),
  agentType: z.string().optional(),
})

const PermissionDecisionSchema = z.enum(['grant', 'deny', 'skip', 'grant_always'])

const AnalyzeThreadRequestSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  messages: z.array(z.object({ from: z.string(), dateMs: z.number(), bodyText: z.string() })),
  provider: ProviderInjection,
})

const AnalyzeBilibiliRequestSchema = z.object({
  bvid: z.string(),
  provider: ProviderInjection,
  text: z.string(),
  title: z.string(),
  author: z.string(),
  source: z.enum(['subtitle', 'transcript']),
})

// ---- ServiceMethod: methods the service process serves -------------------

export type ServiceMethodSignatures = {
  createSession: { args: [ProviderInjection]; result: { sessionId: string } }
  forkSession: { args: [string, number]; result: { sessionId: string } }
  submitPrompt: { args: [string, string, Attachment[]?, SubmitOptions?]; result: { runId: string } }
  analyzeThread: { args: [AnalyzeThreadRequest]; result: AnalyzeThreadResult }
  collectArticle: { args: [ArticleSource]; result: CollectArticleResult }
  analyzeArticle: { args: [AnalyzeArticleRequest]; result: AnalyzeArticleResult }
  analyzeBilibili: { args: [AnalyzeBilibiliRequest]; result: AnalyzeBilibiliResult }
  listArticles: { args: []; result: CollectedArticleWithAnalysis[] }
  getArticleAnalysis: { args: [string]; result: { summary: ArticleSummary | null; analyzedAt: string | null } }
  deleteArticle: { args: [string]; result: void }
  researchRepo: { args: [ResearchRepoRequest]; result: ResearchRepoResult }
  getRepoResearch: { args: [string]; result: { research: RepoResearch | null; researchedAt: string | null } }
  researchedRepoNames: { args: []; result: string[] }
  listSessions: { args: []; result: SessionSummary[] }
  getSessionEntries: { args: [string, number?]; result: EntryRow[] }
  exportSessionMarkdown: { args: [string]; result: { path: string } }
  deleteSession: { args: [string]; result: { ok: true } }
  renameSession: { args: [string, string]; result: { ok: true } }
  setSessionPinned: { args: [string, boolean]; result: { ok: true } }
  updateSessionSettings: { args: [string, SessionSettings]; result: { ok: true } }
  reorderSessions: { args: [string[]]; result: { ok: true } }
  decidePermission: { args: [string, string, PermissionDecision]; result: { ok: true } }
  cancelRun: { args: [string]; result: { ok: true } }
  setMcpServers: { args: [McpServerConfig[]]; result: { ok: true } }
  getMcpStatus: { args: []; result: McpServerStatus[] }
  setWebSearchConfig: { args: [WebSearchInjection]; result: { ok: true } }
  setBudgetConfig: { args: [BudgetConfig]; result: { ok: true } }
  listSkills: { args: []; result: Skill[] }
  listAgents: { args: []; result: AgentListItem[] }
  saveAgent: { args: [AgentDefinition]; result: AgentMutationResult }
  deleteAgent: { args: [string]; result: AgentMutationResult }
  restoreDefaultAgents: { args: []; result: AgentMutationResult }
  saveSkill: { args: [Skill]; result: SkillMutationResult }
  deleteSkill: { args: [string]; result: SkillMutationResult }
  importSkill: { args: [string, boolean?]; result: SkillMutationResult }
  getToolToggles: { args: []; result: ToolToggles }
  setSkillEnabled: { args: [string, boolean]; result: ToolToggles }
  setToolGroupEnabled: { args: [string, boolean]; result: ToolToggles }
  listToolGroups: { args: []; result: ToolGroupInfo[] }
  listMemory: { args: [string?]; result: MemoryView[] }
  getUsageStats: { args: [number]; result: UsageStats }
  listCronJobsForSession: { args: [string]; result: CronJobSummary[] }
  listAllCronJobs: { args: []; result: ScheduledTask[] }
  listAllCronRuns: { args: []; result: CronRun[] }
  cancelCronJob: { args: [string]; result: { ok: true } }
}

export type ServiceMethod = keyof ServiceMethodSignatures

// Args validators, one per method — the mapped type makes a missing entry or
// an output/signature mismatch a compile error. Precision is graded: primitive
// args are exact; mutating complex objects use their real schemas; provider-
// shaped open payloads reuse the existing (already loose-ish) schema consts.
// Optional trailing args use plain .optional(): the dispatcher normalizes
// top-level null -> undefined before parsing (WS JSON turns undefined into
// null in arrays; no table method takes null as a meaningful top-level arg).
export const serviceMethodArgSchemas: {
  [M in ServiceMethod]: z.ZodType<ServiceMethodSignatures[M]['args']>
} = {
  createSession: z.tuple([ProviderInjection]),
  forkSession: z.tuple([z.string(), z.number()]),
  submitPrompt: z.tuple([
    z.string(),
    z.string().min(1),
    z.array(AttachmentSchema).optional(),
    SubmitOptionsSchema.optional(),
  ]),
  analyzeThread: z.tuple([AnalyzeThreadRequestSchema]),
  collectArticle: z.tuple([ArticleSource]),
  analyzeArticle: z.tuple([AnalyzeArticleRequest]),
  analyzeBilibili: z.tuple([AnalyzeBilibiliRequestSchema]),
  listArticles: z.tuple([]),
  getArticleAnalysis: z.tuple([z.string()]),
  deleteArticle: z.tuple([z.string()]),
  researchRepo: z.tuple([ResearchRepoRequest]),
  getRepoResearch: z.tuple([z.string()]),
  researchedRepoNames: z.tuple([]),
  listSessions: z.tuple([]),
  getSessionEntries: z.tuple([z.string(), z.number().optional()]),
  exportSessionMarkdown: z.tuple([z.string()]),
  deleteSession: z.tuple([z.string()]),
  renameSession: z.tuple([z.string(), z.string()]),
  setSessionPinned: z.tuple([z.string(), z.boolean()]),
  updateSessionSettings: z.tuple([z.string(), SessionSettingsSchema]),
  reorderSessions: z.tuple([z.array(z.string())]),
  decidePermission: z.tuple([z.string(), z.string(), PermissionDecisionSchema]),
  cancelRun: z.tuple([z.string()]),
  setMcpServers: z.tuple([z.array(McpServerConfigSchema)]),
  getMcpStatus: z.tuple([]),
  setWebSearchConfig: z.tuple([WebSearchInjection]),
  setBudgetConfig: z.tuple([BudgetConfigSchema]),
  listSkills: z.tuple([]),
  listAgents: z.tuple([]),
  saveAgent: z.tuple([AgentDefinitionSchema]),
  deleteAgent: z.tuple([z.string()]),
  restoreDefaultAgents: z.tuple([]),
  saveSkill: z.tuple([SkillSchema]),
  deleteSkill: z.tuple([z.string()]),
  importSkill: z.tuple([z.string(), z.boolean().optional()]),
  getToolToggles: z.tuple([]),
  setSkillEnabled: z.tuple([z.string(), z.boolean()]),
  setToolGroupEnabled: z.tuple([z.string(), z.boolean()]),
  listToolGroups: z.tuple([]),
  listMemory: z.tuple([z.string().optional()]),
  getUsageStats: z.tuple([z.number()]),
  listCronJobsForSession: z.tuple([z.string()]),
  listAllCronJobs: z.tuple([]),
  listAllCronRuns: z.tuple([]),
  cancelCronJob: z.tuple([z.string()]),
}

// ---- MainMethod: methods only Main serves (called by the service) --------
// Args are the contract (typed below); results stay `unknown` in this pass —
// today's callers cast results at the call site, and WS peers can never reach
// these handlers (the bridge only forwards peer requests INTO the service
// process), so there is no runtime schema table for this direction.

export type MainMethodSignatures = {
  'gmail.search': { args: [string, number?]; result: unknown }
  'gmail.get_thread': { args: [string]; result: unknown }
  'gmail.list_recent': { args: [{ limit?: number; label?: string }?]; result: unknown }
  'gmail.save_thread_analysis': { args: [string, ThreadAnalysisPayload]; result: unknown }
  'bilibili.save_analysis': { args: [string, unknown]; result: unknown }
  'calendar.list_upcoming': { args: [number?]; result: unknown }
  'calendar.get_event': { args: [string]; result: unknown }
  'calendar.create_local': { args: [CalendarLocalInput]; result: unknown }
  'calendar.update_local': { args: [string, Partial<CalendarLocalInput>]; result: unknown }
  'calendar.delete_local': { args: [string]; result: unknown }
  'weather.get_forecast': { args: [number, number]; result: unknown }
}

export type MainMethod = keyof MainMethodSignatures

// The service-side "call out to main" function shape (tools, analyzers).
export type CallMainFn = <M extends MainMethod>(method: M, args: MainMethodSignatures[M]['args']) => Promise<unknown>
