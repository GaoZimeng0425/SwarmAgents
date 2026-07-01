// src/main/gmail/ipc.ts
//
// Wires the Gmail service to Electron IPC (renderer-facing handlers) and
// exposes the main-rpc query handlers the service→main bridge dispatches to.
// Mirrors budgets/ipc.ts; broadcasts gmail:stateChanged to all windows.
import { createLogger } from '@shared/logger'
import type { GmailClientCreds, MainMethod } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'gmail-ipc' })

const STATE_CHANGED = 'gmail:stateChanged'

export type MainRpcHandlers = Record<MainMethod, (...args: unknown[]) => Promise<unknown>>

export function wireGmailIpc(args: { service: Service }): {
  dispose: () => void
  mainRpcHandlers: MainRpcHandlers
} {
  const { service } = args

  const unsubscribe = service.onStateChanged((view) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED, view)
    }
  })

  ipcMain.handle('gmail:getStatus', () => service.getView())
  ipcMain.handle('gmail:setClientCreds', (_e, creds: GmailClientCreds) => service.setClientCreds(creds))
  ipcMain.handle('gmail:clearClientCreds', () => service.clearClientCreds())
  ipcMain.handle('gmail:linkAccount', () => service.linkAccount())
  ipcMain.handle('gmail:unlinkAccount', () => service.unlinkAccount())
  ipcMain.handle('gmail:syncNow', () => service.syncNow())

  const mainRpcHandlers: MainRpcHandlers = {
    'gmail.search': (q, limit) => Promise.resolve(service.search(String(q), Number(limit ?? 20))),
    'gmail.get_thread': (id) => Promise.resolve(service.getThread(String(id))),
    'gmail.list_recent': (input) => {
      const opts = (input as { limit?: number; label?: string } | undefined) ?? {}
      return Promise.resolve(service.listRecent({ limit: opts.limit ?? 20, label: opts.label }))
    },
  }

  log.info({ msg: 'gmail IPC wired' })

  return {
    dispose() {
      unsubscribe()
      for (const ch of [
        'gmail:getStatus',
        'gmail:setClientCreds',
        'gmail:clearClientCreds',
        'gmail:linkAccount',
        'gmail:unlinkAccount',
        'gmail:syncNow',
      ]) {
        ipcMain.removeHandler(ch)
      }
    },
    mainRpcHandlers,
  }
}
