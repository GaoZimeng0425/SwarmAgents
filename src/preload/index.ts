import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

import type { McpMutationResult, McpServerConfig, McpServerStatus, McpToolOverride } from '../shared/types/mcp'
import type { ApiStyle, ModelThinkingLevel, ProviderId, ProvidersStateView } from '../shared/types/provider'
import type { Skill, SkillMutationResult } from '../shared/types/skill'
import type {
  MacPermissions,
  McpBridge,
  MemoryBridge,
  PermissionDecision,
  ProvidersBridge,
  ProvidersSetResult,
  ProvidersTestResult,
  SkillBridge,
  SubmitGoalResult,
  SwarmBridge,
  UIEvent,
  WebSearchBridge,
  WebSearchKeyId,
  WebSearchSetResult,
} from '../shared/types/ui'
import type { WebSearchConfigView, WebSearchProviderId } from '../shared/types/web-search'

const IPC_EVENT_CHANNEL = 'swarm:event'
const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
const PROVIDERS_STATE_CHANNEL = 'providers:stateChanged'
const PROVIDERS_DECRYPT_FAILED_CHANNEL = 'providers:decryptFailed'
const MCP_CONFIG_CHANGED_CHANNEL = 'mcp:configChanged'
const MCP_STATUS_CHANNEL = 'mcp:status'
const WEB_SEARCH_STATE_CHANNEL = 'webSearch:stateChanged'

const providers: ProvidersBridge = {
  get: () => ipcRenderer.invoke('providers:get') as Promise<ProvidersStateView>,
  setKey: (p: ProviderId, key: string) => ipcRenderer.invoke('providers:setKey', p, key) as Promise<ProvidersSetResult>,
  clearKey: (p: ProviderId) => ipcRenderer.invoke('providers:clearKey', p) as Promise<ProvidersSetResult>,
  setActive: (p: ProviderId | null) => ipcRenderer.invoke('providers:setActive', p) as Promise<ProvidersSetResult>,
  setModel: (p: ProviderId, model: string) =>
    ipcRenderer.invoke('providers:setModel', p, model) as Promise<ProvidersSetResult>,
  setBaseUrl: (p: ProviderId, baseUrl: string | null) =>
    ipcRenderer.invoke('providers:setBaseUrl', p, baseUrl) as Promise<ProvidersSetResult>,
  addCustomModel: (p: ProviderId, model: string) =>
    ipcRenderer.invoke('providers:addCustomModel', p, model) as Promise<ProvidersSetResult>,
  removeCustomModel: (p: ProviderId, model: string) =>
    ipcRenderer.invoke('providers:removeCustomModel', p, model) as Promise<ProvidersSetResult>,
  setApiStyle: (p: ProviderId, style: ApiStyle) =>
    ipcRenderer.invoke('providers:setApiStyle', p, style) as Promise<ProvidersSetResult>,
  setThinkingLevel: (p: ProviderId, level: ModelThinkingLevel) =>
    ipcRenderer.invoke('providers:setThinkingLevel', p, level) as Promise<ProvidersSetResult>,
  setContextWindow: (p: ProviderId, contextWindow: number | null) =>
    ipcRenderer.invoke('providers:setContextWindow', p, contextWindow) as Promise<ProvidersSetResult>,
  test: (p: ProviderId) => ipcRenderer.invoke('providers:test', p) as Promise<ProvidersTestResult>,
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

const skills: SkillBridge = {
  list: () => ipcRenderer.invoke('skills:list') as Promise<Skill[]>,
  save: (skill: Skill) => ipcRenderer.invoke('skills:save', skill) as Promise<SkillMutationResult>,
  remove: (name: string) => ipcRenderer.invoke('skills:delete', name) as Promise<SkillMutationResult>,
}

const memory: MemoryBridge = {
  list: (namespace?: string) =>
    ipcRenderer.invoke('memory:list', namespace) as Promise<import('../shared/types/memory').MemoryView[]>,
}

const swarm: SwarmBridge = {
  submitGoal: (sessionId, goal, attachments) =>
    ipcRenderer.invoke('swarm:submitGoal', sessionId, goal, attachments) as Promise<SubmitGoalResult>,
  cancelTask: (sessionId, taskId) => ipcRenderer.invoke('swarm:cancelTask', sessionId, taskId) as Promise<void>,
  decidePermission: (sessionId, actionId, decision: PermissionDecision) =>
    ipcRenderer.invoke('swarm:decidePermission', sessionId, actionId, decision) as Promise<void>,
  respondAsk: (sessionId, askId, answer) =>
    ipcRenderer.invoke('swarm:respondAsk', sessionId, askId, answer) as Promise<void>,
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
  },
  subscribeEvents: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: UIEvent): void => cb(payload)
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener)
    }
  },
  getAccent: () => ipcRenderer.invoke('system:getAccent') as Promise<string | null>,
  onAccentChange: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { hex: string }): void => cb(payload.hex)
    ipcRenderer.on(ACCENT_CHANGE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(ACCENT_CHANGE_CHANNEL, listener)
    }
  },
  showConfirm: (req) => ipcRenderer.invoke('system:showConfirm', req) as Promise<'grant' | 'deny' | 'skip'>,
  openSettings: (opts) => ipcRenderer.invoke('system:openSettings', opts) as Promise<void>,
  getMacPermissions: () => ipcRenderer.invoke('system:getMacPermissions') as Promise<MacPermissions>,
  openPrivacySettings: (pane) => ipcRenderer.invoke('system:openPrivacySettings', pane) as Promise<void>,
  readImageFile: (path: string) =>
    ipcRenderer.invoke('system:readImageFile', path) as Promise<{ mimeType: string; data: string } | null>,
  openPath: (path: string) => ipcRenderer.invoke('system:openPath', path) as Promise<void>,
  providers,
  mcp,
  webSearch,
  skills,
  memory,
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
