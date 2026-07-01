// src/main/web-search/ipc.ts
//
// Wires the web-search config subsystem to Electron IPC. Exposes get / setProvider
// / setKey / clearKey / setSearxngUrl handlers and broadcasts state changes (the
// redacted view) to all renderer windows.
import { createLogger } from '@shared/logger'
import { WebSearchProviderId } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { KeyId, Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'web-search-ipc' })

const STATE_CHANGED_CHANNEL = 'webSearch:stateChanged'

function asKeyId(v: unknown): KeyId | null {
  return v === 'tavily' || v === 'brave' ? v : null
}

export function wireWebSearchIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args

  const unsubscribe = service.onStateChanged((view) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED_CHANNEL, view)
    }
  })

  ipcMain.handle('webSearch:get', () => service.getView())

  ipcMain.handle('webSearch:setProvider', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const pid = WebSearchProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    return service.setProvider(pid.data)
  })

  ipcMain.handle('webSearch:setKey', (_e: Electron.IpcMainInvokeEvent, id: unknown, key: unknown) => {
    const kid = asKeyId(id)
    if (!kid) return { ok: false, code: 'invalid', message: 'unknown key id' }
    if (typeof key !== 'string') return { ok: false, code: 'invalid', message: 'key must be a string' }
    return service.setKey(kid, key)
  })

  ipcMain.handle('webSearch:clearKey', (_e: Electron.IpcMainInvokeEvent, id: unknown) => {
    const kid = asKeyId(id)
    if (!kid) return { ok: false, code: 'invalid', message: 'unknown key id' }
    return service.clearKey(kid)
  })

  ipcMain.handle('webSearch:setSearxngUrl', (_e: Electron.IpcMainInvokeEvent, url: unknown) => {
    if (url !== null && typeof url !== 'string')
      return { ok: false, code: 'invalid', message: 'url must be a string or null' }
    return service.setSearxngUrl(url)
  })

  log.info({ msg: 'web-search IPC wired' })

  return {
    dispose(): void {
      unsubscribe()
      ipcMain.removeHandler('webSearch:get')
      ipcMain.removeHandler('webSearch:setProvider')
      ipcMain.removeHandler('webSearch:setKey')
      ipcMain.removeHandler('webSearch:clearKey')
      ipcMain.removeHandler('webSearch:setSearxngUrl')
    },
  }
}
