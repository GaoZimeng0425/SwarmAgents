/**
 * Events streamed from Main → Renderer over the preload bridge.
 *
 * These are derived from Supervisor events plus task-creation hooks. They are
 * deliberately a thinner, renderer-friendly view of the IPC types — the
 * Renderer should not need to know about MessagePort, Outbound discriminants,
 * etc. Each event carries a server-side timestamp so the UI can render a
 * linear timeline without needing its own clock.
 */

import type { AgentDefinition, AgentListItem, AgentMutationResult } from './agent'
import type { BiliListResult, BiliLoginStatus, BiliProcessResult, BiliSaveResult, ObsidianConfig, BiliVideo, BiliSummary } from './bilibili'
import type { BudgetConfig } from './budgets'
import type { Risk } from './ipc'
import type { McpMutationResult, McpServerConfig, McpServerStatus, McpToolOverride } from './mcp'
import type { MemoryView } from './memory'
import type { ApiStyle, ModelThinkingLevel, ProvidersStateView } from './provider'
import type { Skill, SkillMutationResult } from './skill'
import type {
  Attachment,
  ConsumedResources,
  ExecutionMode,
  PermissionMode,
  PlanTodo,
  TaskEvent,
  TaskOptions,
  TaskResult,
} from './task'
import type { ToolGroupInfo, ToolToggles } from './tool-toggles'
import type { WebSearchConfigView, WebSearchProviderId } from './web-search'

export type UIEvent =
  | {
      kind: 'task.created'
      sessionId: string
      taskId: string
      goal: string
      attachments?: Attachment[]
      /** Set when this task is a spawned sub-agent; links it to its parent for grouped rendering. */
      parentTaskId?: string
      /** Sub-agent definition id (e.g. 'researcher'), used to label the subagent block. */
      agentDefId?: string
      ts: number
    }
  | { kind: 'task.dispatched'; sessionId: string; taskId: string; workerId: string; ts: number }
  | { kind: 'task.progress'; sessionId: string; taskId: string; event: TaskEvent; ts: number }
  | {
      kind: 'task.tool_call'
      sessionId: string
      taskId: string
      workerId: string
      tool: string
      args: unknown
      ts: number
    }
  | {
      kind: 'task.permission_request'
      sessionId: string
      taskId: string
      workerId: string
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
      ts: number
    }
  | { kind: 'task.complete'; sessionId: string; taskId: string; summary: string; ts: number }
  | { kind: 'task.error'; sessionId: string; taskId: string; error: unknown; ts: number }
  | {
      kind: 'task.usage'
      sessionId: string
      taskId: string
      used: ConsumedResources
      /** Latest turn's context occupancy and the model's context-window size (for the composer ring). */
      contextTokens?: number
      contextWindow?: number
      ts: number
    }
  | { kind: 'task.plan'; sessionId: string; taskId: string; todos: PlanTodo[]; ts: number }
  | { kind: 'task.handoff.spawned'; sessionId: string; parentTaskId: string; childTaskId: string; ts: number }
  | {
      kind: 'task.handoff.completed'
      sessionId: string
      parentTaskId: string
      childTaskId: string
      childSummary: string
      ts: number
    }
  | { kind: 'session.created'; sessionId: string; title: string | null; ts: number }
  | { kind: 'session.updated'; sessionId: string; title: string | null; lastActiveAt: number; ts: number }
  | { kind: 'memory.changed'; ts: number }
  | { kind: 'skills.changed'; ts: number }
  | { kind: 'agents.changed'; ts: number }

export type SessionSummary = {
  id: string
  title: string | null
  status: 'active' | 'interrupted' | 'ended'
  lastActiveAt: number
  taskCount: number
  /** Cumulative usage across the session's tasks, summed from persisted `used`
   * snapshots so the list can show cost without hydrating tasks. Populated by
   * listSessions; absent on optimistically-created session rows (treat as 0). */
  tokensUsed?: number
  usdCents?: number
  pinned: boolean
  sortOrder: number
  /** True only for the dedicated system session that owns all global cron jobs. */
  isSystem: boolean
  /** Composer controls remembered per session; restored when the session reopens. */
  cwd?: string
  permissionMode?: PermissionMode
  executionMode?: ExecutionMode
  /** Composer-chosen entry agent: 'ceo' (the company default) or a team head's id. */
  agentType?: string
}

/** The per-session composer controls persisted on the session row. */
export type SessionSettings = {
  cwd?: string
  permissionMode?: PermissionMode
  executionMode?: ExecutionMode
  /** Composer-chosen entry agent: 'ceo' (the company default) or a team head's id. */
  agentType?: string
}

export type CronJobSummary = {
  id: string
  sessionId: string
  /** The conversation that created this job; null when unknown/legacy. */
  originSessionId: string | null
  name: string | null
  cron: string
  goal: string
  createdAt: number
  lastRunAt: number | null
  nextRun: number | null
}

export type ScheduledTask = CronJobSummary & {
  sessionTitle: string | null
  /** Title of the originating conversation, or null if it was deleted / unknown. */
  originSessionTitle: string | null
}

/** One past execution of a scheduled job, surfaced to the renderer's calendar. */
export type CronRun = {
  id: string
  jobId: string
  sessionId: string
  taskId: string | null
  status: string
  triggeredAt: number
  endedAt: number | null
  error: string | null
}

export type PermissionDecision = 'grant' | 'deny' | 'skip'

export type SubmitGoalResult = { taskId: string }

export type ProvidersSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type ProvidersAddResult =
  | { ok: true; id: string }
  | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type AddCustomProviderInput = {
  name: string
  apiKey: string
  apiStyle: ApiStyle
  baseUrl?: string | null
  models: string[]
  thinkingLevel?: ModelThinkingLevel
}

export type ProvidersTestResult =
  | { ok: true; latencyMs: number; url: string }
  | {
      ok: false
      code: 'no_key' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
      message: string
      url?: string
    }

export type ProvidersFetchModelInfoResult =
  | { ok: true; matched: number; total: number; unmatched: string[] }
  | { ok: false; code: 'invalid' | 'network'; message: string }

export type BilibiliBridge = {
  status: () => Promise<BiliLoginStatus>
  login: () => Promise<BiliLoginStatus>
  logout: () => Promise<void>
  list: () => Promise<BiliListResult>
  process: (bvid: string) => Promise<BiliProcessResult>
  open: (bvid: string) => Promise<void>
  getObsidianConfig: () => Promise<ObsidianConfig | null>
  setObsidianConfig: (cfg: ObsidianConfig) => Promise<void>
  pickVault: () => Promise<string | null>
  save: (video: BiliVideo, summary: BiliSummary) => Promise<BiliSaveResult>
}

export type ProvidersBridge = {
  get(): Promise<ProvidersStateView>
  /** id is a builtin id ('anthropic'|'openai') or a custom provider id. */
  setKey(id: string, key: string): Promise<ProvidersSetResult>
  /** Built-in only; remove the slot. Custom providers use removeCustomProvider. */
  clearKey(id: string): Promise<ProvidersSetResult>
  setActive(id: string | null): Promise<ProvidersSetResult>
  setModel(id: string, model: string): Promise<ProvidersSetResult>
  /** Pass empty string or null to clear. */
  setBaseUrl(id: string, baseUrl: string | null): Promise<ProvidersSetResult>
  addCustomModel(id: string, model: string): Promise<ProvidersSetResult>
  removeCustomModel(id: string, model: string): Promise<ProvidersSetResult>
  /** Custom providers only. */
  setApiStyle(id: string, style: ApiStyle): Promise<ProvidersSetResult>
  /** Set the reasoning depth for a provider's model. */
  setThinkingLevel(id: string, level: ModelThinkingLevel): Promise<ProvidersSetResult>
  /** Set the ordered fallback provider ids tried when this provider's request fails. */
  setFallbackProviderIds(id: string, ids: string[]): Promise<ProvidersSetResult>
  /** Custom providers only. Set/clear one model's context window. Pass null to clear. */
  setModelContextWindow(id: string, model: string, contextWindow: number | null): Promise<ProvidersSetResult>
  /** Custom providers only. Pull per-model context + pricing from OpenRouter for all models. */
  fetchModelInfo(id: string): Promise<ProvidersFetchModelInfoResult>
  // Custom-provider lifecycle.
  addCustomProvider(input: AddCustomProviderInput): Promise<ProvidersAddResult>
  removeCustomProvider(id: string): Promise<ProvidersSetResult>
  renameCustomProvider(id: string, name: string): Promise<ProvidersSetResult>
  test(id: string): Promise<ProvidersTestResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
  onDecryptFailed(cb: () => void): () => void
}

export type McpBridge = {
  list(): Promise<McpServerConfig[]>
  add(input: Omit<McpServerConfig, 'id'>): Promise<McpMutationResult & { id?: string }>
  update(id: string, patch: Partial<Omit<McpServerConfig, 'id'>>): Promise<McpMutationResult>
  remove(id: string): Promise<McpMutationResult>
  setEnabled(id: string, enabled: boolean): Promise<McpMutationResult>
  setToolOverride(id: string, toolName: string, override: McpToolOverride | null): Promise<McpMutationResult>
  getStatus(): Promise<McpServerStatus[]>
  onConfigChanged(cb: (configs: McpServerConfig[]) => void): () => void
  onStatus(cb: (statuses: McpServerStatus[]) => void): () => void
}

export type WebSearchSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type WebSearchKeyId = 'tavily' | 'brave'

export type WebSearchBridge = {
  get(): Promise<WebSearchConfigView>
  setProvider(p: WebSearchProviderId): Promise<WebSearchSetResult>
  setKey(id: WebSearchKeyId, key: string): Promise<WebSearchSetResult>
  clearKey(id: WebSearchKeyId): Promise<WebSearchSetResult>
  /** Pass an empty string or null to clear. */
  setSearxngUrl(url: string | null): Promise<WebSearchSetResult>
  onStateChanged(cb: (v: WebSearchConfigView) => void): () => void
}

export type BudgetsSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type BudgetsBridge = {
  get(): Promise<BudgetConfig>
  set(config: BudgetConfig): Promise<BudgetsSetResult>
  onStateChanged(cb: (c: BudgetConfig) => void): () => void
}

export type SkillBridge = {
  list(): Promise<Skill[]>
  save(skill: Skill): Promise<SkillMutationResult>
  remove(name: string): Promise<SkillMutationResult>
  importFolder(arg?: { sourceDir?: string; overwrite?: boolean }): Promise<SkillMutationResult & { sourceDir?: string }>
}

export type MemoryBridge = {
  list(namespace?: string): Promise<MemoryView[]>
}

export type AgentBridge = {
  list(): Promise<AgentListItem[]>
  save(def: AgentDefinition): Promise<AgentMutationResult>
  remove(id: string): Promise<AgentMutationResult>
  /** Re-seed the shipped builtins (add new, update changed, prune retired); keeps user-authored agents. */
  restoreDefaults(): Promise<AgentMutationResult>
}

/** Global enable/disable for built-in tool groups + skills (MCP toggled via `mcp`). */
export type ToolTogglesBridge = {
  get(): Promise<ToolToggles>
  /** Built-in tool groups with their bare tool names + current enabled state. */
  listGroups(): Promise<ToolGroupInfo[]>
  setSkillEnabled(name: string, enabled: boolean): Promise<ToolToggles>
  setToolGroupEnabled(group: string, enabled: boolean): Promise<ToolToggles>
}

/** Status of a macOS TCC permission. 'unsupported' on non-macOS platforms. */
export type MacPermissionState = 'granted' | 'denied' | 'not-determined' | 'unsupported'

/** macOS permissions the peekaboo screen tools depend on. */
export type MacPermissions = {
  screenRecording: MacPermissionState
  accessibility: MacPermissionState
}

/**
 * The shape exposed to the renderer via contextBridge as `window.swarm`.
 */
export type SwarmBridge = {
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: Attachment[],
    options?: TaskOptions
  ): Promise<SubmitGoalResult>
  cancelTask(sessionId: string, taskId: string): Promise<void>
  interruptWith(sessionId: string, taskId: string): Promise<void>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  sessions: {
    list(): Promise<SessionSummary[]>
    create(): Promise<{ sessionId: string }>
    getTasks(sessionId: string): Promise<import('./task').Task[]>
    delete(sessionId: string): Promise<void>
    rename(sessionId: string, title: string): Promise<void>
    setPinned(sessionId: string, pinned: boolean): Promise<void>
    reorder(orderedIds: string[]): Promise<void>
    updateSettings(sessionId: string, settings: SessionSettings): Promise<void>
  }
  usage: {
    get(rangeDays: number): Promise<import('./usage').UsageStats>
  }
  trending: {
    get(period: import('./trending').TrendingPeriod, language: string): Promise<import('./trending').TrendingRepo[]>
  }
  cron: {
    listForSession(sessionId: string): Promise<CronJobSummary[]>
    listAll(): Promise<ScheduledTask[]>
    listAllRuns(): Promise<CronRun[]>
    cancel(id: string): Promise<void>
  }
  subscribeEvents(cb: (event: UIEvent) => void): () => void
  /** A swarmagents://chat/<id> deep link routes here. Pushed when the app is already running. */
  onNavigateToSession(cb: (sessionId: string) => void): () => void
  /** Main pushes a /settings route here (menu / deep-link) for in-app navigation. */
  onNavigateToSettings(cb: (route: string) => void): () => void
  /** Pull a chat deep link that arrived before the renderer subscribed (cold start). One-shot: clears after read. */
  consumePendingDeepLink(): Promise<{ sessionId: string } | null>
  /** Get the current system accent color (RRGGBBAA hex). Returns null on unsupported platforms. */
  getAccent(): Promise<string | null>
  /** Subscribe to accent-color changes. Returns an unsubscribe function. */
  onAccentChange(cb: (hex: string) => void): () => void
  /** Current macOS screen-recording / accessibility permission status. */
  getMacPermissions(): Promise<MacPermissions>
  /** Open the relevant macOS Privacy & Security settings pane. No-op off macOS. */
  openPrivacySettings(pane: 'screen' | 'accessibility'): Promise<void>
  /** Read a local image file as base64 for inline preview. Returns null if missing or not an image. */
  readImageFile(path: string): Promise<{ mimeType: string; data: string } | null>
  /** Open a local file with the OS default application. */
  openPath(path: string): Promise<void>
  /** Reveal the app's userData folder (where skills/, mcp-servers.json, etc. live). */
  openUserDataDir(): Promise<void>
  /** Show a native open dialog to pick a folder. Returns its absolute path, or null if cancelled. */
  pickDirectory(): Promise<string | null>
  /** Show a native open dialog to pick a file. Returns its absolute path, or null if cancelled. */
  pickFile(): Promise<string | null>
  providers: ProvidersBridge
  mcp: McpBridge
  webSearch: WebSearchBridge
  budgets: BudgetsBridge
  skills: SkillBridge
  toolToggles: ToolTogglesBridge
  memory: MemoryBridge
  agents: AgentBridge
  bilibili: BilibiliBridge
}

// Re-exported for renderer convenience without dragging task.ts types directly.
export type { TaskEvent, TaskResult }
