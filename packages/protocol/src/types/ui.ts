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
import type { AgentWireEvent } from './agent-events'
import type { AnalyzeArticleResult, ArticleSummary, CollectedArticleWithAnalysis } from './article'
import type { Attachment } from './artifact'
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
} from './bilibili'
import type { BudgetConfig } from './budgets'
import type { CalendarClientCreds, CalendarConfigView, CalendarEvent } from './calendar'
import type { ExecutionMode, PermissionMode, SubmitOptions } from './execution'
import type { GmailClientCreds, GmailConfigView, GmailMessage, GmailThread } from './gmail'
import type { McpMutationResult, McpServerConfig, McpServerStatus, McpToolOverride } from './mcp'
import type { MemoryView } from './memory'
import type { ApiStyle, ModelThinkingLevel, ProviderInjection, ProvidersStateView } from './provider'
import type { Skill, SkillMutationResult } from './skill'
import type { ToolGroupInfo, ToolToggles } from './tool-toggles'
import type { RepoResearch } from './trending'
import type { WeatherConfig, WeatherConfigView, WeatherForecast } from './weather'
import type { WebSearchConfigView, WebSearchProviderId } from './web-search'
import type {
  AddColumnInput,
  CreateTaskInput,
  MoveTaskInput,
  RenameColumnInput,
  UpdateTaskInput,
  WorkbenchData,
  WorkbenchMutationResult,
} from './workbench'

/** Renderer→Main: the thread to analyze (no provider — main injects it). */
export type AnalyzeThreadInput = {
  threadId: string
  subject: string
  messages: { from: string; dateMs: number; bodyText: string }[]
}

/** Main→Service: the input plus the resolved active provider. */
export type AnalyzeThreadRequest = AnalyzeThreadInput & { provider: ProviderInjection }

export type AnalyzeThreadResult = { ok: true } | { ok: false; code: 'no_provider' | 'no_agent'; message: string }

/** A structured todo extracted by the thread analyst. */
export type Todo = { t: string; due?: boolean; dueLabel?: string }

/** The structured payload delivered on threadAnalysisComplete. */
export type ThreadAnalysisPayload = {
  summary: string
  todos: Todo[]
  suggest: string
}

/** A cached thread-level analysis row, keyed by thread id. */
export type GmailThreadAnalysis = ThreadAnalysisPayload & { updatedAt: number }

export type UIEvent =
  | AgentWireEvent
  | { kind: 'session.created'; sessionId: string; title: string | null; ts: number; seq?: number }
  | { kind: 'session.updated'; sessionId: string; title: string | null; lastActiveAt: number; ts: number; seq?: number }
  | { kind: 'memory.changed'; ts: number; seq?: number }
  | { kind: 'skills.changed'; ts: number; seq?: number }
  | { kind: 'agents.changed'; ts: number; seq?: number }
  | { kind: 'articles.changed'; ts: number; seq?: number }
  | { kind: 'gmail.threadAnalysisDelta'; threadId: string; text: string; ts: number; seq?: number }
  | {
      kind: 'gmail.threadAnalysisComplete'
      threadId: string
      summary: string
      todos: Todo[]
      suggest: string
      ts: number
      seq?: number
    }
  | { kind: 'gmail.threadAnalysisError'; threadId: string; error: string; ts: number; seq?: number }
  | { kind: 'article.analysisDelta'; articleId: string; text: string; ts: number; seq?: number }
  | { kind: 'article.analysisComplete'; articleId: string; summary: ArticleSummary; ts: number; seq?: number }
  | { kind: 'article.analysisError'; articleId: string; error: string; ts: number; seq?: number }
  | { kind: 'trending.researchDelta'; repoName: string; text: string; ts: number; seq?: number }
  | {
      kind: 'trending.researchComplete'
      repoName: string
      research: RepoResearch
      summary: string
      ts: number
      seq?: number
    }
  | { kind: 'trending.researchError'; repoName: string; error: string; ts: number; seq?: number }
  | { kind: 'bilibili.analysisDelta'; bvid: string; text: string; ts: number; seq?: number }
  | { kind: 'bilibili.analysisComplete'; bvid: string; summary: BiliSummary; ts: number; seq?: number }
  | { kind: 'bilibili.analysisError'; bvid: string; error: string; ts: number; seq?: number }

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
  /** Current context occupancy (latest top-level message's snapshot, not cumulative).
   *  Drives the composer's context-fill ring. Absent on sessions with no usage yet. */
  contextTokens?: number
  /** Model context window size for the latest top-level message. Absent until first usage. */
  contextWindow?: number
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
  prompt: string
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

// 'grant_always' grants THIS request and auto-grants every later request for the
// same tool name in the session (in-memory, session lifetime). The engine never
// sees it: the permission registry records the tool and resolves the pending as
// 'grant'.
export type PermissionDecision = 'grant' | 'deny' | 'skip' | 'grant_always'

/** One entry in the command palette's `/` 产出 scope. */
export type ArtifactEntry = {
  /** Source of the entry. `file` = a filesystem file; `bilibili-analysis` = a saved Bilibili summary. */
  kind: 'file' | 'bilibili-analysis'
  /** Display name: filename for `file`; video title for `bilibili-analysis`. */
  name: string
  /** Filesystem path (`file`) or bvid (`bilibili-analysis`). */
  ref: string
  size?: number
  modifiedAt?: number
  /** Origin label: the cwd path for `file`; "Bilibili" for `bilibili-analysis`. */
  origin: string
}

export type SubmitPromptResult = { runId: string }

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
  getTranscribeConfig: () => Promise<TranscriptionConfig | null>
  setTranscribeConfig: (cfg: TranscriptionConfig) => Promise<void>
  pickModelDir: () => Promise<string | null>
  transcribe: (bvid: string) => Promise<BiliTranscribeResult>
  onTranscribeProgress: (cb: (p: BiliTranscribeProgress) => void) => () => void
  analyzedBvids: () => Promise<string[]>
  getAnalysis: (bvid: string) => Promise<BiliAnalysis | null>
  // Remove a resource from Bilibili. Watch-later needs only bvid; a fav-folder
  // video needs the fav* ids carried on BiliVideo, so it takes the whole video.
  deleteWatchLater: (bvid: string) => Promise<BiliDeleteResult>
  deleteFav: (video: BiliVideo) => Promise<BiliDeleteResult>
  // Local archive: a "soft delete" that keeps the video card locally after it's
  // gone from Bilibili. Backed by bilibili-archive.json.
  archiveList: () => Promise<BiliVideo[]>
  archivePut: (video: BiliVideo) => Promise<void>
  archiveRemove: (bvid: string) => Promise<void>
  // Pins: a local "favorite" shown in a top bar. Backed by bilibili-pins.json.
  pinsList: () => Promise<BiliVideo[]>
  pinsPut: (video: BiliVideo) => Promise<void>
  pinsRemove: (bvid: string) => Promise<void>
}

export type GmailSetResult = { ok: true } | { ok: false; code: string; message: string }

export type GmailBridge = {
  getStatus(): Promise<GmailConfigView>
  setClientCreds(creds: GmailClientCreds): Promise<GmailSetResult>
  clearClientCreds(): Promise<unknown>
  linkAccount(): Promise<GmailSetResult>
  unlinkAccount(): Promise<unknown>
  syncNow(): Promise<void>
  onStateChanged(cb: (view: GmailConfigView) => void): () => void
  // Read access to the synced cache (the inbox view consumes these). Mirror the
  // service/cache method shapes — listRecent newest-first, getThread pulls the
  // full thread + its messages, search matches subject/snippet/from/body.
  listRecent(input: { limit: number; label?: string }): Promise<GmailThread[]>
  getThread(id: string): Promise<{ thread: GmailThread; messages: GmailMessage[] } | null>
  search(query: string, limit: number): Promise<GmailThread[]>
  getThreadAnalysis(threadId: string): Promise<GmailThreadAnalysis | null>
  saveThreadAnalysis(threadId: string, analysis: ThreadAnalysisPayload): Promise<void>
  analyzedThreadIds(): Promise<string[]>
  markThreadRead(threadId: string): Promise<void>
  listInboxPage(page: number): Promise<{ threads: GmailThread[]; total: number }>
}

export type CalendarSetResult = { ok: true } | { ok: false; code: string; message: string }

export type CalendarLocalInput = {
  title: string
  startMs: number
  endMs: number
  allDay?: boolean
  description?: string | null
  location?: string | null
}

export type CalendarBridge = {
  getStatus(): Promise<CalendarConfigView>
  setClientCreds(creds: CalendarClientCreds): Promise<CalendarSetResult>
  clearClientCreds(): Promise<unknown>
  linkAccount(): Promise<CalendarSetResult>
  unlinkAccount(): Promise<unknown>
  syncNow(): Promise<void>
  onStateChanged(cb: (view: CalendarConfigView) => void): () => void
  listInRange(fromMs: number, toMs: number): Promise<CalendarEvent[]>
  createLocal(input: CalendarLocalInput): Promise<CalendarEvent>
  updateLocal(id: string, patch: Partial<CalendarLocalInput>): Promise<CalendarEvent | null>
  deleteLocal(id: string): Promise<boolean>
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

export type WeatherSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type WeatherForecastResult =
  | { ok: true; forecast: WeatherForecast }
  | { ok: false; code: 'not_configured' | 'locate_failed' | 'fetch_failed'; message: string }

export type WeatherBridge = {
  getConfig(): Promise<WeatherConfigView>
  setConfig(c: WeatherConfig): Promise<WeatherSetResult>
  /** lng/lat null → IP fallback in main. */
  getForecast(lng: number | null, lat: number | null): Promise<WeatherForecastResult>
  /** Pushed from main whenever a fresh forecast is fetched. */
  onForecast(cb: (f: WeatherForecast) => void): () => void
  onConfigChanged(cb: (c: WeatherConfigView) => void): () => void
}

export type BudgetsSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type BudgetsBridge = {
  get(): Promise<BudgetConfig>
  set(config: BudgetConfig): Promise<BudgetsSetResult>
  onStateChanged(cb: (c: BudgetConfig) => void): () => void
}

export type WorkbenchBridge = {
  getAll(): Promise<WorkbenchData>
  createTask(input: CreateTaskInput): Promise<WorkbenchMutationResult>
  updateTask(id: string, patch: UpdateTaskInput): Promise<WorkbenchMutationResult>
  completeTask(id: string): Promise<WorkbenchMutationResult>
  reopenTask(id: string): Promise<WorkbenchMutationResult>
  deleteTask(id: string): Promise<WorkbenchMutationResult>
  moveTask(input: MoveTaskInput): Promise<WorkbenchMutationResult>
  addColumn(input: AddColumnInput): Promise<WorkbenchMutationResult>
  renameColumn(input: RenameColumnInput): Promise<WorkbenchMutationResult>
  deleteColumn(id: string): Promise<WorkbenchMutationResult>
  reorderColumns(orderedIds: string[]): Promise<WorkbenchMutationResult>
  onStateChanged(cb: (data: WorkbenchData) => void): () => void
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
  submitPrompt(
    sessionId: string,
    prompt: string,
    attachments?: Attachment[],
    options?: SubmitOptions
  ): Promise<SubmitPromptResult>
  analyzeThread(input: AnalyzeThreadInput): Promise<AnalyzeThreadResult>
  cancelRun(sessionId: string): Promise<void>
  forkSession(sourceSessionId: string, upToRowId: number): Promise<{ sessionId: string }>
  decidePermission(sessionId: string, actionId: string, decision: PermissionDecision): Promise<void>
  sessions: {
    list(): Promise<SessionSummary[]>
    create(): Promise<{ sessionId: string }>
    getSessionEntries(sessionId: string, afterRowId?: number): Promise<import('./session-entry').EntryRow[]>
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
    research(
      repo: import('./trending').TrendingRepo,
      period: import('./trending').TrendingPeriod
    ): Promise<import('./trending').ResearchRepoResult>
    getResearch(repoName: string): Promise<{ research: RepoResearch | null; researchedAt: string | null }>
    researchedNames(): Promise<string[]>
  }
  cron: {
    listForSession(sessionId: string): Promise<CronJobSummary[]>
    listAll(): Promise<ScheduledTask[]>
    listAllRuns(): Promise<CronRun[]>
    cancel(id: string): Promise<void>
  }
  article: {
    list(): Promise<CollectedArticleWithAnalysis[]>
    analyze(articleId: string): Promise<AnalyzeArticleResult>
    getAnalysis(articleId: string): Promise<{ summary: ArticleSummary | null; analyzedAt: string | null }>
    delete(articleId: string): Promise<void>
  }
  /** Build a markdown transcript of a session and write it to the exports dir. */
  exportSessionMarkdown(sessionId: string): Promise<{ path: string }>
  /** Command palette `/` scope: bilibili analyses. */
  listArtifacts(opts?: { query?: string; limit?: number }): Promise<ArtifactEntry[]>
  subscribeEvents(cb: (event: UIEvent) => void): () => void
  /** A swarmagents://chat/<id> deep link routes here. Pushed when the app is already running. */
  onNavigateToSession(cb: (payload: { sessionId?: string; route?: string }) => void): () => void
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
  /** The WS host config (port + token + LAN IP) for the browser extension / RN client to connect. Null if the host isn't up yet. */
  getWsHostConfig(): Promise<{ port: number; token: string; lanIp: string | null } | null>
  /** Read a local image file as base64 for inline preview. Returns null if missing or not an image. */
  readImageFile(path: string): Promise<{ mimeType: string; data: string } | null>
  /** Read a local document file (pdf/docx/xlsx/csv) as base64 for inline preview. Returns null if missing, too large, or unsupported. */
  readDocumentFile(path: string): Promise<{ mediaType: string; data: string } | null>
  /** Open a local file with the OS default application. */
  openPath(path: string): Promise<void>
  /** Reveal the app's userData folder (where skills/, mcp-servers.json, etc. live). */
  openUserDataDir(): Promise<void>
  /** Show a native open dialog to pick a folder. Returns its absolute path, or null if cancelled. */
  pickDirectory(): Promise<string | null>
  /** Show a native open dialog to pick a file. Returns its absolute path, or null if cancelled. */
  pickFile(): Promise<string | null>
  /** List one level of a directory (non-recursive) for the composer's @ file picker.
   *  Returns entries whose name starts with `prefix` (case-insensitive). Hidden files
   *  (dot-prefixed) are excluded. Folders sort before files; capped at 50 entries.
   *  Returns [] for a non-existent or unreadable directory (never throws). */
  listDir(dir: string, prefix?: string): Promise<{ name: string; isDir: boolean }[]>
  providers: ProvidersBridge
  mcp: McpBridge
  webSearch: WebSearchBridge
  weather: WeatherBridge
  budgets: BudgetsBridge
  skills: SkillBridge
  toolToggles: ToolTogglesBridge
  memory: MemoryBridge
  agents: AgentBridge
  bilibili: BilibiliBridge
  gmail: GmailBridge
  calendar: CalendarBridge
  workbench: WorkbenchBridge
  quickPanel: {
    /** Hide the quick panel window. */
    hide(): Promise<void>
    /** Focus the main window, optionally navigating to a session or settings route. */
    focusMain(payload: { navigate?: string; settings?: string }): Promise<void>
    /** Get the currently registered global hotkey accelerator string. */
    getHotkey(): Promise<string>
    /** Register a new global hotkey accelerator. Returns whether it was applied. */
    setHotkey(accelerator: string): Promise<{ ok: boolean }>
  }
}
