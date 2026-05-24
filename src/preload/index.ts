import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

import type { PermissionDecision, SubmitGoalResult, SwarmBridge, UIEvent } from '../shared/types/ui'

const IPC_EVENT_CHANNEL = 'swarm:event'
const ACCENT_CHANGE_CHANNEL = 'system:accentChange'

const swarm: SwarmBridge = {
  submitGoal: (goal) => ipcRenderer.invoke('swarm:submitGoal', goal) as Promise<SubmitGoalResult>,
  cancelTask: (taskId) => ipcRenderer.invoke('swarm:cancelTask', taskId) as Promise<void>,
  decidePermission: (actionId, decision: PermissionDecision) =>
    ipcRenderer.invoke('swarm:decidePermission', actionId, decision) as Promise<void>,
  subscribeEvents: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: UIEvent): void => cb(payload)
    ipcRenderer.on(IPC_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, listener)
    }
  },
  getAccent: () => ipcRenderer.invoke('system:getAccent') as Promise<string | null>,
  onAccentChange: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { hex: string }): void =>
      cb(payload.hex)
    ipcRenderer.on(ACCENT_CHANGE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(ACCENT_CHANGE_CHANNEL, listener)
    }
  },
  showConfirm: (req) =>
    ipcRenderer.invoke('system:showConfirm', req) as Promise<'grant' | 'deny' | 'skip'>,
  openSettings: () => ipcRenderer.invoke('system:openSettings') as Promise<void>,
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
  s.style.cssText =
    'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none'
  s.textContent = '😀🎉✨📦🚀 中文 日本語 한국어 ∑∫√ ✓✗'
  document.body.appendChild(s)
  void s.getBoundingClientRect()
  requestAnimationFrame(() => requestAnimationFrame(() => s.remove()))
})
