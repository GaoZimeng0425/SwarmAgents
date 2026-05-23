import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

import type { PermissionDecision, SubmitGoalResult, SwarmBridge, UIEvent } from '../shared/types/ui'

const IPC_EVENT_CHANNEL = 'swarm:event'

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
