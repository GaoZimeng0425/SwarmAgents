import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

import type { AgentDefinition, AgentListItem, AgentMutationResult } from '../shared/types/agent'
import type { BiliListResult, BiliLoginStatus, BiliProcessResult } from '../shared/types/bilibili'
import type { BudgetConfig } from '../shared/types/budgets'
import type { McpMutationResult, McpServerConfig, McpServerStatus, McpToolOverride } from '../shared/types/mcp'
import type { ApiStyle, ModelThinkingLevel, ProvidersStateView } from '../shared/types/provider'
import type { Skill, SkillMutationResult } from '../shared/types/skill'
import type { ToolGroupInfo, ToolToggles } from '../shared/types/tool-toggles'
import type {
  AddCustomProviderInput,
  AgentBridge,
  BilibiliBridge,
  BudgetsBridge,
  BudgetsSetResult,
  MacPermissions,
  McpBridge,
  MemoryBridge,
  PermissionDecision,
  ProvidersAddResult,
  ProvidersBridge,
  ProvidersFetchModelInfoResult,
  ProvidersSetResult,
  ProvidersTestResult,
  SkillBridge,
  SubmitGoalResult,
  SwarmBridge,
  ToolTogglesBridge,
  UIEvent,
  WebSearchBridge,
  WebSearchKeyId,
  WebSearchSetResult,
} from '../shared/types/ui'
import type { WebSearchConfigView, WebSearchProviderId } from '../shared/types/web-search'

const IPC_EVENT_CHANNEL = 'swarm:event'
const NAVIGATE_CHANNEL = 'swarm:navigate'
const SETTINGS_NAV_CHANNEL = 'swarm:navigate-settings'
const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
const PROVIDERS_STATE_CHANNEL = 'providers:stateChanged'
const PROVIDERS_DECRYPT_FAILED_CHANNEL = 'providers:decryptFailed'
const MCP_CONFIG_CHANGED_CHANNEL = 'mcp:configChanged'
const MCP_STATUS_CHANNEL = 'mcp:status'
const WEB_SEARCH_STATE_CHANNEL = 'webSearch:stateChanged'
const BUDGETS_STATE_CHANNEL = 'budgets:stateChanged'

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
  onDecryptFailed: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(PROVIDERS_DECRYPT_FAILED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(PROVIDERS_DECRYPT_FAILED_CHANNEL, listener)
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
    ipcRenderer.invoke('memory:list', namespace) as Promise<import('../shared/types/memory').MemoryView[]>,
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
}

const swarm: SwarmBridge = {
  submitGoal: (sessionId, goal, attachments, options) =>
    ipcRenderer.invoke('swarm:submitGoal', sessionId, goal, attachments, options) as Promise<SubmitGoalResult>,
  cancelTask: (sessionId, taskId) => ipcRenderer.invoke('swarm:cancelTask', sessionId, taskId) as Promise<void>,
  interruptWith: (sessionId, taskId) => ipcRenderer.invoke('swarm:interruptWith', sessionId, taskId) as Promise<void>,
  decidePermission: (sessionId, actionId, decision: PermissionDecision) =>
    ipcRenderer.invoke('swarm:decidePermission', sessionId, actionId, decision) as Promise<void>,
  sessions: {
    list: () => ipcRenderer.invoke('swarm:listSessions') as Promise<import('../shared/types/ui').SessionSummary[]>,
    create: () => ipcRenderer.invoke('swarm:createSession') as Promise<{ sessionId: string }>,
    getTasks: (sessionId: string) =>
      ipcRenderer.invoke('swarm:getSessionTasks', sessionId) as Promise<import('../shared/types/task').Task[]>,
    delete: (sessionId: string) => ipcRenderer.invoke('swarm:deleteSession', sessionId) as Promise<void>,
    rename: (sessionId: string, title: string) =>
      ipcRenderer.invoke('swarm:renameSession', sessionId, title) as Promise<void>,
    setPinned: (sessionId: string, pinned: boolean) =>
      ipcRenderer.invoke('swarm:setSessionPinned', sessionId, pinned) as Promise<void>,
    updateSettings: (sessionId: string, settings: import('../shared/types/ui').SessionSettings) =>
      ipcRenderer.invoke('swarm:updateSessionSettings', sessionId, settings) as Promise<void>,
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('swarm:reorderSessions', orderedIds) as Promise<void>,
  },
  usage: {
    get: (rangeDays: number) =>
      ipcRenderer.invoke('swarm:getUsageStats', rangeDays) as Promise<import('../shared/types/usage').UsageStats>,
  },
  trending: {
    get: (period: import('../shared/types/trending').TrendingPeriod, language: string) =>
      ipcRenderer.invoke('trending:get', period, language) as Promise<
        import('../shared/types/trending').TrendingRepo[]
      >,
  },
  cron: {
    listForSession: (sessionId: string) =>
      ipcRenderer.invoke('swarm:listCronJobsForSession', sessionId) as Promise<
        import('../shared/types/ui').CronJobSummary[]
      >,
    listAll: () => ipcRenderer.invoke('swarm:listAllCronJobs') as Promise<import('../shared/types/ui').ScheduledTask[]>,
    listAllRuns: () => ipcRenderer.invoke('swarm:listAllCronRuns') as Promise<import('../shared/types/ui').CronRun[]>,
    cancel: (id: string) => ipcRenderer.invoke('swarm:cancelCronJob', id) as Promise<void>,
  },
  subscribeEvents: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: UIEvent): void => cb(payload)
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener)
    }
  },
  onNavigateToSession: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { sessionId: string }): void => cb(payload.sessionId)
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
  readImageFile: (path: string) =>
    ipcRenderer.invoke('system:readImageFile', path) as Promise<{ mimeType: string; data: string } | null>,
  openPath: (path: string) => ipcRenderer.invoke('system:openPath', path) as Promise<void>,
  openUserDataDir: () => ipcRenderer.invoke('system:openUserDataDir') as Promise<void>,
  pickDirectory: () => ipcRenderer.invoke('system:pickPath', 'directory') as Promise<string | null>,
  pickFile: () => ipcRenderer.invoke('system:pickPath', 'file') as Promise<string | null>,
  providers,
  mcp,
  webSearch,
  budgets,
  skills,
  toolToggles,
  memory,
  agents,
  bilibili,
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
