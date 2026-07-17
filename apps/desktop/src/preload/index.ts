import { electronAPI } from '@electron-toolkit/preload'
import type {
  AddCustomProviderInput,
  AgentBridge,
  AgentDefinition,
  ApiStyle,
  BilibiliBridge,
  BiliSummary,
  BiliTranscribeProgress,
  BiliVideo,
  BudgetConfig,
  BudgetsBridge,
  CalendarBridge,
  CalendarClientCreds,
  CalendarConfigView,
  CalendarEvent,
  CalendarLocalInput,
  CalendarSetResult,
  GmailBridge,
  GmailClientCreds,
  GmailConfigView,
  GmailMessage,
  GmailSetResult,
  GmailThread,
  GmailThreadAnalysis,
  McpBridge,
  McpToolOverride,
  MemoryBridge,
  ModelThinkingLevel,
  ObsidianConfig,
  PermissionDecision,
  ProvidersBridge,
  RendererIpcChannel,
  RendererIpcEventChannel,
  RendererIpcEvents,
  RendererIpcSignatures,
  Skill,
  SkillBridge,
  SwarmBridge,
  ThreadAnalysisPayload,
  ToolTogglesBridge,
  TranscriptionConfig,
  WeatherBridge,
  WeatherConfigView,
  WeatherForecastResult,
  WeatherSetResult,
  WebSearchBridge,
  WebSearchKeyId,
  WebSearchProviderId,
  WorkbenchBridge,
  WorkbenchData,
  WorkbenchMutationResult,
} from '@swarm/protocol'
import { contextBridge, ipcRenderer } from 'electron'

// Typed gateways to the renderer-IPC tables. Every bridge member for a
// migrated domain routes through these; unmigrated domains keep raw
// ipcRenderer calls until their plan (see spec §4).
const invoke = <C extends RendererIpcChannel>(
  channel: C,
  ...args: RendererIpcSignatures[C]['args']
): Promise<RendererIpcSignatures[C]['result']> =>
  ipcRenderer.invoke(channel, ...args) as Promise<RendererIpcSignatures[C]['result']>

const subscribe = <C extends RendererIpcEventChannel>(
  channel: C,
  cb: (payload: RendererIpcEvents[C]) => void
): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: RendererIpcEvents[C]): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const providers: ProvidersBridge = {
  get: () => invoke('providers:get'),
  setKey: (id: string, key: string) => invoke('providers:setKey', id, key),
  clearKey: (id: string) => invoke('providers:clearKey', id),
  setActive: (id: string | null) => invoke('providers:setActive', id),
  setModel: (id: string, model: string) => invoke('providers:setModel', id, model),
  setBaseUrl: (id: string, baseUrl: string | null) => invoke('providers:setBaseUrl', id, baseUrl),
  addCustomModel: (id: string, model: string) => invoke('providers:addCustomModel', id, model),
  removeCustomModel: (id: string, model: string) => invoke('providers:removeCustomModel', id, model),
  setApiStyle: (id: string, style: ApiStyle) => invoke('providers:setApiStyle', id, style),
  setThinkingLevel: (id: string, level: ModelThinkingLevel) => invoke('providers:setThinkingLevel', id, level),
  setFallbackProviderIds: (id: string, ids: string[]) => invoke('providers:setFallbackProviderIds', id, ids),
  setModelContextWindow: (id: string, model: string, contextWindow: number | null) =>
    invoke('providers:setModelContextWindow', id, model, contextWindow),
  fetchModelInfo: (id: string) => invoke('providers:fetchModelInfo', id),
  addCustomProvider: (input: AddCustomProviderInput) => invoke('providers:addCustomProvider', input),
  removeCustomProvider: (id: string) => invoke('providers:removeCustomProvider', id),
  renameCustomProvider: (id: string, name: string) => invoke('providers:renameCustomProvider', id, name),
  test: (id: string) => invoke('providers:test', id),
  onStateChanged: (cb) => subscribe('providers:stateChanged', cb),
}

const mcp: McpBridge = {
  list: () => invoke('mcp:list'),
  add: (input) => invoke('mcp:add', input),
  update: (id, patch) => invoke('mcp:update', id, patch),
  remove: (id) => invoke('mcp:remove', id),
  setEnabled: (id, enabled) => invoke('mcp:setEnabled', id, enabled),
  setToolOverride: (id: string, toolName: string, override: McpToolOverride | null) =>
    invoke('mcp:setToolOverride', id, toolName, override),
  getStatus: () => invoke('mcp:getStatus'),
  onConfigChanged: (cb) => subscribe('mcp:configChanged', cb),
  onStatus: (cb) => subscribe('mcp:status', cb),
}

const webSearch: WebSearchBridge = {
  get: () => invoke('webSearch:get'),
  setProvider: (p: WebSearchProviderId) => invoke('webSearch:setProvider', p),
  setKey: (id: WebSearchKeyId, key: string) => invoke('webSearch:setKey', id, key),
  clearKey: (id: WebSearchKeyId) => invoke('webSearch:clearKey', id),
  setSearxngUrl: (url: string | null) => invoke('webSearch:setSearxngUrl', url),
  onStateChanged: (cb) => subscribe('webSearch:stateChanged', cb),
}

const weather: WeatherBridge = {
  getConfig: () => ipcRenderer.invoke('weather:getConfig') as Promise<WeatherConfigView>,
  setConfig: (c) => ipcRenderer.invoke('weather:setConfig', c) as Promise<WeatherSetResult>,
  getForecast: (lng, lat) => ipcRenderer.invoke('weather:getForecast', lng, lat) as Promise<WeatherForecastResult>,
  onForecast: (cb) => subscribe('weather:forecastChanged', cb),
  onConfigChanged: () => () => {},
}

const budgets: BudgetsBridge = {
  get: () => invoke('budgets:get'),
  set: (config: BudgetConfig) => invoke('budgets:set', config),
  onStateChanged: (cb) => subscribe('budgets:stateChanged', cb),
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
  onStateChanged: (cb) => subscribe('workbench:stateChanged', cb),
}

const skills: SkillBridge = {
  list: () => invoke('skills:list'),
  save: (skill: Skill) => invoke('skills:save', skill),
  remove: (name: string) => invoke('skills:delete', name),
  importFolder: (arg?: { sourceDir?: string; overwrite?: boolean }) => invoke('skills:import', arg),
}

const toolToggles: ToolTogglesBridge = {
  get: () => invoke('toolToggles:get'),
  listGroups: () => invoke('tools:listGroups'),
  setSkillEnabled: (name: string, enabled: boolean) => invoke('toolToggles:setSkill', name, enabled),
  setToolGroupEnabled: (group: string, enabled: boolean) => invoke('toolToggles:setToolGroup', group, enabled),
}

const memory: MemoryBridge = {
  list: (namespace?: string) => invoke('memory:list', namespace),
}

const agents: AgentBridge = {
  list: () => invoke('agents:list'),
  save: (def: AgentDefinition) => invoke('agents:save', def),
  remove: (id: string) => invoke('agents:delete', id),
  restoreDefaults: () => invoke('agents:restore-defaults'),
}

const bilibili: BilibiliBridge = {
  status: () => invoke('bilibili:status'),
  login: () => invoke('bilibili:login'),
  logout: () => invoke('bilibili:logout'),
  list: () => invoke('bilibili:list'),
  process: (bvid: string) => invoke('bilibili:process', bvid),
  open: (bvid: string) => invoke('bilibili:open', bvid),
  getObsidianConfig: () => invoke('bilibili:getObsidianConfig'),
  setObsidianConfig: (cfg: ObsidianConfig) => invoke('bilibili:setObsidianConfig', cfg),
  pickVault: () => invoke('bilibili:pickVault'),
  save: (video: BiliVideo, summary: BiliSummary) => invoke('bilibili:save', video, summary),
  getTranscribeConfig: () => invoke('bilibili:getTranscribeConfig'),
  setTranscribeConfig: (cfg: TranscriptionConfig) => invoke('bilibili:setTranscribeConfig', cfg),
  pickModelDir: () => invoke('bilibili:pickModelDir'),
  transcribe: (bvid: string) => invoke('bilibili:transcribe', bvid),
  onTranscribeProgress: (cb: (p: BiliTranscribeProgress) => void) => subscribe('bilibili:transcribe:progress', cb),
  analyzedBvids: () => invoke('bilibili:analyzedBvids'),
  getAnalysis: (bvid: string) => invoke('bilibili:getAnalysis', bvid),
  deleteWatchLater: (bvid: string) => invoke('bilibili:deleteWatchLater', bvid),
  deleteFav: (video: BiliVideo) => invoke('bilibili:deleteFav', video),
  archiveList: () => invoke('bilibili:archiveList'),
  archivePut: (video: BiliVideo) => invoke('bilibili:archivePut', video),
  archiveRemove: (bvid: string) => invoke('bilibili:archiveRemove', bvid),
  pinsList: () => invoke('bilibili:pinsList'),
  pinsPut: (video: BiliVideo) => invoke('bilibili:pinsPut', video),
  pinsRemove: (bvid: string) => invoke('bilibili:pinsRemove', bvid),
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
  onStateChanged: (cb: (view: GmailConfigView) => void) => subscribe('gmail:stateChanged', cb),
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
  onStateChanged: (cb: (view: CalendarConfigView) => void) => subscribe('calendar:stateChanged', cb),
}

const swarm: SwarmBridge = {
  submitPrompt: (sessionId, prompt, attachments, options) =>
    invoke('swarm:submitPrompt', sessionId, prompt, attachments, options),
  analyzeThread: (input: import('@swarm/protocol').AnalyzeThreadInput) => invoke('swarm:analyzeThread', input),
  cancelRun: (sessionId) => invoke('swarm:cancelRun', sessionId),
  decidePermission: (sessionId, actionId, decision: PermissionDecision) =>
    invoke('swarm:decidePermission', sessionId, actionId, decision),
  forkSession: (sourceSessionId: string, upToRowId: number) => invoke('swarm:forkSession', sourceSessionId, upToRowId),
  sessions: {
    list: () => invoke('swarm:listSessions'),
    create: () => invoke('swarm:createSession'),
    getSessionEntries: (sessionId: string, afterRowId?: number) =>
      invoke('swarm:getSessionEntries', sessionId, afterRowId),
    delete: async (sessionId: string) => {
      await invoke('swarm:deleteSession', sessionId)
    },
    rename: async (sessionId: string, title: string) => {
      await invoke('swarm:renameSession', sessionId, title)
    },
    setPinned: async (sessionId: string, pinned: boolean) => {
      await invoke('swarm:setSessionPinned', sessionId, pinned)
    },
    updateSettings: async (sessionId: string, settings: import('@swarm/protocol').SessionSettings) => {
      await invoke('swarm:updateSessionSettings', sessionId, settings)
    },
    reorder: async (orderedIds: string[]) => {
      await invoke('swarm:reorderSessions', orderedIds)
    },
  },
  usage: {
    get: (rangeDays: number) => invoke('swarm:getUsageStats', rangeDays),
  },
  trending: {
    get: (period: import('@swarm/protocol').TrendingPeriod, language: string) =>
      invoke('trending:get', period, language),
    research: (repo: import('@swarm/protocol').TrendingRepo, period: import('@swarm/protocol').TrendingPeriod) =>
      invoke('trending:research', repo, period),
    getResearch: (repoName: string) => invoke('trending:getResearch', repoName),
    researchedNames: () => invoke('trending:researchedNames'),
  },
  cron: {
    listForSession: (sessionId: string) => invoke('swarm:listCronJobsForSession', sessionId),
    listAll: () => invoke('swarm:listAllCronJobs'),
    listAllRuns: () => invoke('swarm:listAllCronRuns'),
    cancel: async (id: string) => {
      await invoke('swarm:cancelCronJob', id)
    },
  },
  article: {
    list: () => invoke('swarm:article:list'),
    analyze: (articleId: string) => invoke('swarm:article:analyze', articleId),
    getAnalysis: (articleId: string) => invoke('swarm:article:getAnalysis', articleId),
    delete: (articleId: string) => invoke('swarm:article:delete', articleId),
  },
  exportSessionMarkdown: (sessionId: string) => invoke('swarm:exportSessionMarkdown', sessionId),
  listArtifacts: (opts?: { query?: string; limit?: number }) => invoke('swarm:listArtifacts', opts),
  subscribeEvents: (cb) => subscribe('swarm:event', cb),
  onNavigateToSession: (cb) => subscribe('swarm:navigate', cb),
  onNavigateToSettings: (cb) => subscribe('swarm:navigate-settings', (p) => cb(p.route)),
  consumePendingDeepLink: () => invoke('swarm:consumePendingDeepLink'),
  getAccent: () => invoke('system:getAccent'),
  onAccentChange: (cb) => subscribe('system:accentChange', (p) => cb(p.hex)),
  getMacPermissions: () => invoke('system:getMacPermissions'),
  openPrivacySettings: (pane) => invoke('system:openPrivacySettings', pane),
  getWsHostConfig: () => invoke('system:getWsHostConfig'),
  readImageFile: (path: string) => invoke('system:readImageFile', path),
  readDocumentFile: (path: string) => invoke('system:readDocumentFile', path),
  openPath: (path: string) => invoke('system:openPath', path),
  openUserDataDir: () => invoke('system:openUserDataDir'),
  pickDirectory: () => invoke('system:pickPath', 'directory'),
  pickFile: () => invoke('system:pickPath', 'file'),
  listDir: (dir: string, prefix?: string) => invoke('system:listDir', dir, prefix),
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
    hide: () => invoke('swarm:quickPanel:hide'),
    focusMain: (payload: { navigate?: string; settings?: string }) => invoke('swarm:quickPanel:focusMain', payload),
    getHotkey: () => invoke('swarm:quickPanel:getHotkey'),
    setHotkey: (accelerator: string) => invoke('swarm:quickPanel:setHotkey', accelerator),
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
