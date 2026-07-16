import { electronAPI } from '@electron-toolkit/preload'
import type {
  AddCustomProviderInput,
  AgentBridge,
  AgentDefinition,
  AgentListItem,
  AgentMutationResult,
  AnalyzeArticleResult,
  ApiStyle,
  ArticleSummary,
  BiliAnalysis,
  BilibiliBridge,
  BiliDeleteResult,
  BiliListResult,
  BiliLoginStatus,
  BiliProcessResult,
  BiliSaveResult,
  BiliSummary,
  BiliTranscribeProgress,
  BiliTranscribeResult,
  BiliVideo,
  BudgetConfig,
  BudgetsBridge,
  BudgetsSetResult,
  CalendarBridge,
  CalendarClientCreds,
  CalendarConfigView,
  CalendarEvent,
  CalendarLocalInput,
  CalendarSetResult,
  CollectedArticleWithAnalysis,
  GmailBridge,
  GmailClientCreds,
  GmailConfigView,
  GmailMessage,
  GmailSetResult,
  GmailThread,
  GmailThreadAnalysis,
  MacPermissions,
  McpBridge,
  McpMutationResult,
  McpServerConfig,
  McpServerStatus,
  McpToolOverride,
  MemoryBridge,
  ModelThinkingLevel,
  ObsidianConfig,
  PermissionDecision,
  ProvidersAddResult,
  ProvidersBridge,
  ProvidersFetchModelInfoResult,
  ProvidersSetResult,
  ProvidersStateView,
  ProvidersTestResult,
  Skill,
  SkillBridge,
  SkillMutationResult,
  SubmitPromptResult,
  SwarmBridge,
  ThreadAnalysisPayload,
  ToolGroupInfo,
  ToolToggles,
  ToolTogglesBridge,
  TranscriptionConfig,
  UIEvent,
  WeatherBridge,
  WeatherConfigView,
  WeatherForecast,
  WeatherForecastResult,
  WeatherSetResult,
  WebSearchBridge,
  WebSearchConfigView,
  WebSearchKeyId,
  WebSearchProviderId,
  WebSearchSetResult,
  WorkbenchBridge,
  WorkbenchData,
  WorkbenchMutationResult,
} from '@swarm/protocol'
import { contextBridge, ipcRenderer } from 'electron'

const IPC_EVENT_CHANNEL = 'swarm:event'
const NAVIGATE_CHANNEL = 'swarm:navigate'
const SETTINGS_NAV_CHANNEL = 'swarm:navigate-settings'
const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
const PROVIDERS_STATE_CHANNEL = 'providers:stateChanged'
const MCP_CONFIG_CHANGED_CHANNEL = 'mcp:configChanged'
const MCP_STATUS_CHANNEL = 'mcp:status'
const WEB_SEARCH_STATE_CHANNEL = 'webSearch:stateChanged'
const WEATHER_FORECAST_CHANNEL = 'weather:forecastChanged'
const BUDGETS_STATE_CHANNEL = 'budgets:stateChanged'
const WORKBENCH_STATE_CHANNEL = 'workbench:stateChanged'

const providers: ProvidersBridge = {
  get: () => ipcRenderer.invoke('providers:get') as Promise<ProvidersStateView>,
  setKey: (id: string, key: string) => ipcRenderer.invoke('providers:setKey', id, key) as Promise<ProvidersSetResult>,
  clearKey: (id: string) => ipcRenderer.invoke('providers:clearKey', id) as Promise<ProvidersSetResult>,
  setActive: (id: string | null) => ipcRenderer.invoke('providers:setActive', id) as Promise<ProvidersSetResult>,
  setModel: (id: string, model: string) =>
    ipcRenderer.invoke('providers:setModel', id, model) as Promise<ProvidersSetResult>,
  setBaseUrl: (id: string, baseUrl: string | null) =>
    ipcRenderer.invoke('providers:setBaseUrl', id, baseUrl) as Promise<ProvidersSetResult>,
  addCustomModel: (id: string, model: string) =>
    ipcRenderer.invoke('providers:addCustomModel', id, model) as Promise<ProvidersSetResult>,
  removeCustomModel: (id: string, model: string) =>
    ipcRenderer.invoke('providers:removeCustomModel', id, model) as Promise<ProvidersSetResult>,
  setApiStyle: (id: string, style: ApiStyle) =>
    ipcRenderer.invoke('providers:setApiStyle', id, style) as Promise<ProvidersSetResult>,
  setThinkingLevel: (id: string, level: ModelThinkingLevel) =>
    ipcRenderer.invoke('providers:setThinkingLevel', id, level) as Promise<ProvidersSetResult>,
  setFallbackProviderIds: (id: string, ids: string[]) =>
    ipcRenderer.invoke('providers:setFallbackProviderIds', id, ids) as Promise<ProvidersSetResult>,
  setModelContextWindow: (id: string, model: string, contextWindow: number | null) =>
    ipcRenderer.invoke('providers:setModelContextWindow', id, model, contextWindow) as Promise<ProvidersSetResult>,
  fetchModelInfo: (id: string) =>
    ipcRenderer.invoke('providers:fetchModelInfo', id) as Promise<ProvidersFetchModelInfoResult>,
  addCustomProvider: (input: AddCustomProviderInput) =>
    ipcRenderer.invoke('providers:addCustomProvider', input) as Promise<ProvidersAddResult>,
  removeCustomProvider: (id: string) =>
    ipcRenderer.invoke('providers:removeCustomProvider', id) as Promise<ProvidersSetResult>,
  renameCustomProvider: (id: string, name: string) =>
    ipcRenderer.invoke('providers:renameCustomProvider', id, name) as Promise<ProvidersSetResult>,
  test: (id: string) => ipcRenderer.invoke('providers:test', id) as Promise<ProvidersTestResult>,
  onStateChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: ProvidersStateView): void => cb(payload)
    ipcRenderer.on(PROVIDERS_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(PROVIDERS_STATE_CHANNEL, listener)
    }
  },
}

const mcp: McpBridge = {
  list: () => ipcRenderer.invoke('mcp:list') as Promise<McpServerConfig[]>,
  add: (input) => ipcRenderer.invoke('mcp:add', input) as Promise<McpMutationResult & { id?: string }>,
  update: (id, patch) => ipcRenderer.invoke('mcp:update', id, patch) as Promise<McpMutationResult>,
  remove: (id) => ipcRenderer.invoke('mcp:remove', id) as Promise<McpMutationResult>,
  setEnabled: (id, enabled) => ipcRenderer.invoke('mcp:setEnabled', id, enabled) as Promise<McpMutationResult>,
  setToolOverride: (id: string, toolName: string, override: McpToolOverride | null) =>
    ipcRenderer.invoke('mcp:setToolOverride', id, toolName, override) as Promise<McpMutationResult>,
  getStatus: () => ipcRenderer.invoke('mcp:getStatus') as Promise<McpServerStatus[]>,
  onConfigChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: McpServerConfig[]): void => cb(payload)
    ipcRenderer.on(MCP_CONFIG_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(MCP_CONFIG_CHANGED_CHANNEL, listener)
    }
  },
  onStatus: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: McpServerStatus[]): void => cb(payload)
    ipcRenderer.on(MCP_STATUS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(MCP_STATUS_CHANNEL, listener)
    }
  },
}

const webSearch: WebSearchBridge = {
  get: () => ipcRenderer.invoke('webSearch:get') as Promise<WebSearchConfigView>,
  setProvider: (p: WebSearchProviderId) =>
    ipcRenderer.invoke('webSearch:setProvider', p) as Promise<WebSearchSetResult>,
  setKey: (id: WebSearchKeyId, key: string) =>
    ipcRenderer.invoke('webSearch:setKey', id, key) as Promise<WebSearchSetResult>,
  clearKey: (id: WebSearchKeyId) => ipcRenderer.invoke('webSearch:clearKey', id) as Promise<WebSearchSetResult>,
  setSearxngUrl: (url: string | null) =>
    ipcRenderer.invoke('webSearch:setSearxngUrl', url) as Promise<WebSearchSetResult>,
  onStateChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: WebSearchConfigView): void => cb(payload)
    ipcRenderer.on(WEB_SEARCH_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WEB_SEARCH_STATE_CHANNEL, listener)
    }
  },
}

const weather: WeatherBridge = {
  getConfig: () => ipcRenderer.invoke('weather:getConfig') as Promise<WeatherConfigView>,
  setConfig: (c) => ipcRenderer.invoke('weather:setConfig', c) as Promise<WeatherSetResult>,
  getForecast: (lng, lat) => ipcRenderer.invoke('weather:getForecast', lng, lat) as Promise<WeatherForecastResult>,
  onForecast: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: WeatherForecast): void => cb(payload)
    ipcRenderer.on(WEATHER_FORECAST_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WEATHER_FORECAST_CHANNEL, listener)
    }
  },
  onConfigChanged: () => () => {},
}

const budgets: BudgetsBridge = {
  get: () => ipcRenderer.invoke('budgets:get') as Promise<BudgetConfig>,
  set: (config: BudgetConfig) => ipcRenderer.invoke('budgets:set', config) as Promise<BudgetsSetResult>,
  onStateChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: BudgetConfig): void => cb(payload)
    ipcRenderer.on(BUDGETS_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(BUDGETS_STATE_CHANNEL, listener)
    }
  },
}

const workbench: WorkbenchBridge = {
  getAll: () => ipcRenderer.invoke('workbench:getAll') as Promise<WorkbenchData>,
  createTask: (input) => ipcRenderer.invoke('workbench:createTask', input) as Promise<WorkbenchMutationResult>,
  updateTask: (id, patch) => ipcRenderer.invoke('workbench:updateTask', id, patch) as Promise<WorkbenchMutationResult>,
  completeTask: (id) => ipcRenderer.invoke('workbench:completeTask', id) as Promise<WorkbenchMutationResult>,
  reopenTask: (id) => ipcRenderer.invoke('workbench:reopenTask', id) as Promise<WorkbenchMutationResult>,
  deleteTask: (id) => ipcRenderer.invoke('workbench:deleteTask', id) as Promise<WorkbenchMutationResult>,
  moveTask: (input) => ipcRenderer.invoke('workbench:moveTask', input) as Promise<WorkbenchMutationResult>,
  addColumn: (input) => ipcRenderer.invoke('workbench:addColumn', input) as Promise<WorkbenchMutationResult>,
  renameColumn: (input) => ipcRenderer.invoke('workbench:renameColumn', input) as Promise<WorkbenchMutationResult>,
  deleteColumn: (id) => ipcRenderer.invoke('workbench:deleteColumn', id) as Promise<WorkbenchMutationResult>,
  reorderColumns: (orderedIds) =>
    ipcRenderer.invoke('workbench:reorderColumns', orderedIds) as Promise<WorkbenchMutationResult>,
  onStateChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: WorkbenchData): void => cb(payload)
    ipcRenderer.on(WORKBENCH_STATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WORKBENCH_STATE_CHANNEL, listener)
    }
  },
}

const skills: SkillBridge = {
  list: () => ipcRenderer.invoke('skills:list') as Promise<Skill[]>,
  save: (skill: Skill) => ipcRenderer.invoke('skills:save', skill) as Promise<SkillMutationResult>,
  remove: (name: string) => ipcRenderer.invoke('skills:delete', name) as Promise<SkillMutationResult>,
  importFolder: (arg?: { sourceDir?: string; overwrite?: boolean }) =>
    ipcRenderer.invoke('skills:import', arg) as Promise<SkillMutationResult & { sourceDir?: string }>,
}

const toolToggles: ToolTogglesBridge = {
  get: () => ipcRenderer.invoke('toolToggles:get') as Promise<ToolToggles>,
  listGroups: () => ipcRenderer.invoke('tools:listGroups') as Promise<ToolGroupInfo[]>,
  setSkillEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('toolToggles:setSkill', name, enabled) as Promise<ToolToggles>,
  setToolGroupEnabled: (group: string, enabled: boolean) =>
    ipcRenderer.invoke('toolToggles:setToolGroup', group, enabled) as Promise<ToolToggles>,
}

const memory: MemoryBridge = {
  list: (namespace?: string) =>
    ipcRenderer.invoke('memory:list', namespace) as Promise<import('@swarm/protocol').MemoryView[]>,
}

const agents: AgentBridge = {
  list: () => ipcRenderer.invoke('agents:list') as Promise<AgentListItem[]>,
  save: (def: AgentDefinition) => ipcRenderer.invoke('agents:save', def) as Promise<AgentMutationResult>,
  remove: (id: string) => ipcRenderer.invoke('agents:delete', id) as Promise<AgentMutationResult>,
  restoreDefaults: () => ipcRenderer.invoke('agents:restore-defaults') as Promise<AgentMutationResult>,
}

const bilibili: BilibiliBridge = {
  status: () => ipcRenderer.invoke('bilibili:status') as Promise<BiliLoginStatus>,
  login: () => ipcRenderer.invoke('bilibili:login') as Promise<BiliLoginStatus>,
  logout: () => ipcRenderer.invoke('bilibili:logout') as Promise<void>,
  list: () => ipcRenderer.invoke('bilibili:list') as Promise<BiliListResult>,
  process: (bvid: string) => ipcRenderer.invoke('bilibili:process', bvid) as Promise<BiliProcessResult>,
  open: (bvid: string) => ipcRenderer.invoke('bilibili:open', bvid) as Promise<void>,
  getObsidianConfig: () => ipcRenderer.invoke('bilibili:getObsidianConfig') as Promise<ObsidianConfig | null>,
  setObsidianConfig: (cfg: ObsidianConfig) => ipcRenderer.invoke('bilibili:setObsidianConfig', cfg) as Promise<void>,
  pickVault: () => ipcRenderer.invoke('bilibili:pickVault') as Promise<string | null>,
  save: (video: BiliVideo, summary: BiliSummary) =>
    ipcRenderer.invoke('bilibili:save', video, summary) as Promise<BiliSaveResult>,
  getTranscribeConfig: () => ipcRenderer.invoke('bilibili:getTranscribeConfig') as Promise<TranscriptionConfig | null>,
  setTranscribeConfig: (cfg: TranscriptionConfig) =>
    ipcRenderer.invoke('bilibili:setTranscribeConfig', cfg) as Promise<void>,
  pickModelDir: () => ipcRenderer.invoke('bilibili:pickModelDir') as Promise<string | null>,
  transcribe: (bvid: string) => ipcRenderer.invoke('bilibili:transcribe', bvid) as Promise<BiliTranscribeResult>,
  onTranscribeProgress: (cb: (p: BiliTranscribeProgress) => void) => {
    const listener = (_e: unknown, p: BiliTranscribeProgress): void => cb(p)
    ipcRenderer.on('bilibili:transcribe:progress', listener)
    return () => {
      ipcRenderer.removeListener('bilibili:transcribe:progress', listener)
    }
  },
  analyzedBvids: () => ipcRenderer.invoke('bilibili:analyzedBvids') as Promise<string[]>,
  getAnalysis: (bvid: string) => ipcRenderer.invoke('bilibili:getAnalysis', bvid) as Promise<BiliAnalysis | null>,
  deleteWatchLater: (bvid: string) =>
    ipcRenderer.invoke('bilibili:deleteWatchLater', bvid) as Promise<BiliDeleteResult>,
  deleteFav: (video: BiliVideo) => ipcRenderer.invoke('bilibili:deleteFav', video) as Promise<BiliDeleteResult>,
  archiveList: () => ipcRenderer.invoke('bilibili:archiveList') as Promise<BiliVideo[]>,
  archivePut: (video: BiliVideo) => ipcRenderer.invoke('bilibili:archivePut', video) as Promise<void>,
  archiveRemove: (bvid: string) => ipcRenderer.invoke('bilibili:archiveRemove', bvid) as Promise<void>,
  pinsList: () => ipcRenderer.invoke('bilibili:pinsList') as Promise<BiliVideo[]>,
  pinsPut: (video: BiliVideo) => ipcRenderer.invoke('bilibili:pinsPut', video) as Promise<void>,
  pinsRemove: (bvid: string) => ipcRenderer.invoke('bilibili:pinsRemove', bvid) as Promise<void>,
}

const gmail: GmailBridge = {
  getStatus: () => ipcRenderer.invoke('gmail:getStatus') as Promise<GmailConfigView>,
  setClientCreds: (creds: GmailClientCreds) =>
    ipcRenderer.invoke('gmail:setClientCreds', creds) as Promise<GmailSetResult>,
  clearClientCreds: () => ipcRenderer.invoke('gmail:clearClientCreds') as Promise<unknown>,
  linkAccount: () => ipcRenderer.invoke('gmail:linkAccount') as Promise<GmailSetResult>,
  unlinkAccount: () => ipcRenderer.invoke('gmail:unlinkAccount') as Promise<unknown>,
  syncNow: () => ipcRenderer.invoke('gmail:syncNow') as Promise<void>,
  listRecent: (input: { limit: number; label?: string }) =>
    ipcRenderer.invoke('gmail:listRecent', input) as Promise<GmailThread[]>,
  getThread: (id: string) =>
    ipcRenderer.invoke('gmail:getThread', id) as Promise<{
      thread: GmailThread
      messages: GmailMessage[]
    } | null>,
  search: (query: string, limit: number) => ipcRenderer.invoke('gmail:search', query, limit) as Promise<GmailThread[]>,
  getThreadAnalysis: (threadId: string) =>
    ipcRenderer.invoke('gmail:getThreadAnalysis', threadId) as Promise<GmailThreadAnalysis | null>,
  saveThreadAnalysis: (threadId: string, analysis: ThreadAnalysisPayload) =>
    ipcRenderer.invoke('gmail:saveThreadAnalysis', threadId, analysis) as Promise<void>,
  analyzedThreadIds: () => ipcRenderer.invoke('gmail:analyzedThreadIds') as Promise<string[]>,
  markThreadRead: (threadId: string) => ipcRenderer.invoke('gmail:markThreadRead', threadId) as Promise<void>,
  listInboxPage: (page: number) =>
    ipcRenderer.invoke('gmail:listInboxPage', page) as Promise<{ threads: GmailThread[]; total: number }>,
  onStateChanged: (cb: (view: GmailConfigView) => void) => {
    const listener = (_e: unknown, view: GmailConfigView): void => cb(view)
    ipcRenderer.on('gmail:stateChanged', listener)
    return () => {
      ipcRenderer.removeListener('gmail:stateChanged', listener)
    }
  },
}

const calendar: CalendarBridge = {
  getStatus: () => ipcRenderer.invoke('calendar:getStatus') as Promise<CalendarConfigView>,
  setClientCreds: (creds: CalendarClientCreds) =>
    ipcRenderer.invoke('calendar:setClientCreds', creds) as Promise<CalendarSetResult>,
  clearClientCreds: () => ipcRenderer.invoke('calendar:clearClientCreds') as Promise<unknown>,
  linkAccount: () => ipcRenderer.invoke('calendar:linkAccount') as Promise<CalendarSetResult>,
  unlinkAccount: () => ipcRenderer.invoke('calendar:unlinkAccount') as Promise<unknown>,
  syncNow: () => ipcRenderer.invoke('calendar:syncNow') as Promise<void>,
  listInRange: (fromMs: number, toMs: number) =>
    ipcRenderer.invoke('calendar:listInRange', fromMs, toMs) as Promise<CalendarEvent[]>,
  createLocal: (input: CalendarLocalInput) =>
    ipcRenderer.invoke('calendar:createLocal', input) as Promise<CalendarEvent>,
  updateLocal: (id: string, patch: Partial<CalendarLocalInput>) =>
    ipcRenderer.invoke('calendar:updateLocal', id, patch) as Promise<CalendarEvent | null>,
  deleteLocal: (id: string) => ipcRenderer.invoke('calendar:deleteLocal', id) as Promise<boolean>,
  onStateChanged: (cb: (view: CalendarConfigView) => void) => {
    const listener = (_e: unknown, view: CalendarConfigView): void => cb(view)
    ipcRenderer.on('calendar:stateChanged', listener)
    return () => {
      ipcRenderer.removeListener('calendar:stateChanged', listener)
    }
  },
}

const swarm: SwarmBridge = {
  submitPrompt: (sessionId, prompt, attachments, options) =>
    ipcRenderer.invoke('swarm:submitPrompt', sessionId, prompt, attachments, options) as Promise<SubmitPromptResult>,
  analyzeThread: (input: import('@swarm/protocol').AnalyzeThreadInput) =>
    ipcRenderer.invoke('swarm:analyzeThread', input) as Promise<import('@swarm/protocol').AnalyzeThreadResult>,
  cancelRun: (sessionId) => ipcRenderer.invoke('swarm:cancelRun', sessionId) as Promise<void>,
  decidePermission: (sessionId, actionId, decision: PermissionDecision) =>
    ipcRenderer.invoke('swarm:decidePermission', sessionId, actionId, decision) as Promise<void>,
  forkSession: (sourceSessionId: string, upToRowId: number) =>
    ipcRenderer.invoke('swarm:forkSession', sourceSessionId, upToRowId) as Promise<{ sessionId: string }>,
  sessions: {
    list: () => ipcRenderer.invoke('swarm:listSessions') as Promise<import('@swarm/protocol').SessionSummary[]>,
    create: () => ipcRenderer.invoke('swarm:createSession') as Promise<{ sessionId: string }>,
    getSessionEntries: (sessionId: string, afterRowId?: number) =>
      ipcRenderer.invoke('swarm:getSessionEntries', sessionId, afterRowId) as Promise<
        import('@swarm/protocol').EntryRow[]
      >,
    delete: (sessionId: string) => ipcRenderer.invoke('swarm:deleteSession', sessionId) as Promise<void>,
    rename: (sessionId: string, title: string) =>
      ipcRenderer.invoke('swarm:renameSession', sessionId, title) as Promise<void>,
    setPinned: (sessionId: string, pinned: boolean) =>
      ipcRenderer.invoke('swarm:setSessionPinned', sessionId, pinned) as Promise<void>,
    updateSettings: (sessionId: string, settings: import('@swarm/protocol').SessionSettings) =>
      ipcRenderer.invoke('swarm:updateSessionSettings', sessionId, settings) as Promise<void>,
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('swarm:reorderSessions', orderedIds) as Promise<void>,
  },
  usage: {
    get: (rangeDays: number) =>
      ipcRenderer.invoke('swarm:getUsageStats', rangeDays) as Promise<import('@swarm/protocol').UsageStats>,
  },
  trending: {
    get: (period: import('@swarm/protocol').TrendingPeriod, language: string) =>
      ipcRenderer.invoke('trending:get', period, language) as Promise<import('@swarm/protocol').TrendingRepo[]>,
    research: (repo: import('@swarm/protocol').TrendingRepo, period: import('@swarm/protocol').TrendingPeriod) =>
      ipcRenderer.invoke('trending:research', repo, period) as Promise<import('@swarm/protocol').ResearchRepoResult>,
    getResearch: (repoName: string) =>
      ipcRenderer.invoke('trending:getResearch', repoName) as Promise<{
        research: import('@swarm/protocol').RepoResearch | null
        researchedAt: string | null
      }>,
    researchedNames: () => ipcRenderer.invoke('trending:researchedNames') as Promise<string[]>,
  },
  cron: {
    listForSession: (sessionId: string) =>
      ipcRenderer.invoke('swarm:listCronJobsForSession', sessionId) as Promise<
        import('@swarm/protocol').CronJobSummary[]
      >,
    listAll: () => ipcRenderer.invoke('swarm:listAllCronJobs') as Promise<import('@swarm/protocol').ScheduledTask[]>,
    listAllRuns: () => ipcRenderer.invoke('swarm:listAllCronRuns') as Promise<import('@swarm/protocol').CronRun[]>,
    cancel: (id: string) => ipcRenderer.invoke('swarm:cancelCronJob', id) as Promise<void>,
  },
  article: {
    list: () => ipcRenderer.invoke('swarm:article:list') as Promise<CollectedArticleWithAnalysis[]>,
    analyze: (articleId: string) =>
      ipcRenderer.invoke('swarm:article:analyze', articleId) as Promise<AnalyzeArticleResult>,
    getAnalysis: (articleId: string) =>
      ipcRenderer.invoke('swarm:article:getAnalysis', articleId) as Promise<{
        summary: ArticleSummary | null
        analyzedAt: string | null
      }>,
    delete: (articleId: string) => ipcRenderer.invoke('swarm:article:delete', articleId) as Promise<void>,
  },
  exportSessionMarkdown: (sessionId: string) =>
    ipcRenderer.invoke('swarm:exportSessionMarkdown', sessionId) as Promise<{ path: string }>,
  listArtifacts: (opts?: { query?: string; limit?: number }) =>
    ipcRenderer.invoke('swarm:listArtifacts', opts) as Promise<import('@swarm/protocol').ArtifactEntry[]>,
  subscribeEvents: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: UIEvent): void => cb(payload)
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener)
    }
  },
  onNavigateToSession: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { sessionId?: string; route?: string }): void =>
      cb(payload)
    ipcRenderer.on(NAVIGATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(NAVIGATE_CHANNEL, listener)
    }
  },
  onNavigateToSettings: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { route: string }): void => cb(payload.route)
    ipcRenderer.on(SETTINGS_NAV_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(SETTINGS_NAV_CHANNEL, listener)
    }
  },
  consumePendingDeepLink: () =>
    ipcRenderer.invoke('swarm:consumePendingDeepLink') as Promise<{ sessionId: string } | null>,
  getAccent: () => ipcRenderer.invoke('system:getAccent') as Promise<string | null>,
  onAccentChange: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { hex: string }): void => cb(payload.hex)
    ipcRenderer.on(ACCENT_CHANGE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(ACCENT_CHANGE_CHANNEL, listener)
    }
  },
  getMacPermissions: () => ipcRenderer.invoke('system:getMacPermissions') as Promise<MacPermissions>,
  openPrivacySettings: (pane) => ipcRenderer.invoke('system:openPrivacySettings', pane) as Promise<void>,
  getWsHostConfig: () =>
    ipcRenderer.invoke('system:getWsHostConfig') as Promise<{
      port: number
      token: string
      lanIp: string | null
    } | null>,
  readImageFile: (path: string) =>
    ipcRenderer.invoke('system:readImageFile', path) as Promise<{ mimeType: string; data: string } | null>,
  readDocumentFile: (path: string) =>
    ipcRenderer.invoke('system:readDocumentFile', path) as Promise<{ mediaType: string; data: string } | null>,
  openPath: (path: string) => ipcRenderer.invoke('system:openPath', path) as Promise<void>,
  openUserDataDir: () => ipcRenderer.invoke('system:openUserDataDir') as Promise<void>,
  pickDirectory: () => ipcRenderer.invoke('system:pickPath', 'directory') as Promise<string | null>,
  pickFile: () => ipcRenderer.invoke('system:pickPath', 'file') as Promise<string | null>,
  listDir: (dir: string, prefix?: string) =>
    ipcRenderer.invoke('system:listDir', dir, prefix) as Promise<{ name: string; isDir: boolean }[]>,
  providers,
  mcp,
  webSearch,
  weather,
  budgets,
  skills,
  toolToggles,
  memory,
  agents,
  bilibili,
  gmail,
  calendar,
  workbench,
  quickPanel: {
    hide: () => ipcRenderer.invoke('swarm:quickPanel:hide'),
    resize: (height: number) => ipcRenderer.invoke('swarm:quickPanel:resize', height),
    focusMain: (payload: { navigate?: string; settings?: string }) =>
      ipcRenderer.invoke('swarm:quickPanel:focusMain', payload),
    getHotkey: () => ipcRenderer.invoke('swarm:quickPanel:getHotkey') as Promise<string>,
    setHotkey: (accelerator: string) =>
      ipcRenderer.invoke('swarm:quickPanel:setHotkey', accelerator) as Promise<{ ok: boolean }>,
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('swarm', swarm)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error — populated for non-isolated contexts (dev fallback)
  window.electron = electronAPI
  // @ts-expect-error — populated for non-isolated contexts (dev fallback)
  window.swarm = swarm
}

// ship C.25: disable spellcheck red underlines on chrome.
// (Per-input opt-in via `spellCheck` attribute can override.)
window.addEventListener('DOMContentLoaded', () => {
  document.body.spellcheck = false
})

// SKILL.md 03-webview-survival § A.9: prewarm emoji + CJK fallback fonts so
// the first time the WebView renders a CJK glyph or emoji it doesn't stutter.
// Placeholder text in task-input already contains 中文, so this is load-bearing
// on the very first interaction.
window.addEventListener('DOMContentLoaded', () => {
  const s = document.createElement('span')
  s.setAttribute('aria-hidden', 'true')
  s.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none'
  s.textContent = '😀🎉✨📦🚀 中文 日本語 한국어 ∑∫√ ✓✗'
  document.body.appendChild(s)
  void s.getBoundingClientRect()
  requestAnimationFrame(() => requestAnimationFrame(() => s.remove()))
})
