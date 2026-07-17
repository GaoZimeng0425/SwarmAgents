// src/main/calendar/ipc.ts
//
// Wires the Calendar service to Electron IPC (renderer handlers) and exposes
// the main-rpc query/CRUD handlers the service->main bridge dispatches to.
// Mirrors gmail/ipc.ts; broadcasts calendar:stateChanged to all windows.
import { createLogger } from '@shared/logger'
import type { CalendarClientCreds, MainMethod, MainMethodSignatures } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { LocalEventInput } from './cache'
import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-ipc' })

const STATE_CHANGED = 'calendar:stateChanged'

type CalendarMethod = Extract<MainMethod, `calendar.${string}`>
export type RpcHandlers = {
  [M in CalendarMethod]: (...args: MainMethodSignatures[M]['args']) => Promise<unknown>
}

export function wireCalendarIpc(args: { service: Service }): {
  dispose: () => void
  rpcHandlers: RpcHandlers
} {
  const { service } = args

  const unsubscribe = service.onStateChanged((view) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED, view)
    }
  })

  ipcMain.handle('calendar:getStatus', () => service.getView())
  ipcMain.handle('calendar:setClientCreds', (_e, creds: CalendarClientCreds) => service.setClientCreds(creds))
  ipcMain.handle('calendar:clearClientCreds', () => service.clearClientCreds())
  ipcMain.handle('calendar:linkAccount', () => service.linkAccount())
  ipcMain.handle('calendar:unlinkAccount', () => service.unlinkAccount())
  ipcMain.handle('calendar:syncNow', () => service.syncNow())
  ipcMain.handle('calendar:listInRange', (_e, fromMs: number, toMs: number) =>
    service.listInRange(Number(fromMs), Number(toMs))
  )
  ipcMain.handle('calendar:createLocal', (_e, input: LocalEventInput) => service.createLocal(input))
  ipcMain.handle('calendar:updateLocal', (_e, id: string, patch: Partial<LocalEventInput>) =>
    service.updateLocal(String(id), patch)
  )
  ipcMain.handle('calendar:deleteLocal', (_e, id: string) => service.deleteLocal(String(id)))

  const DAY_MS = 24 * 60 * 60 * 1000
  const rpcHandlers: RpcHandlers = {
    'calendar.list_upcoming': (days) => {
      const d = Number(days ?? 14)
      const now = Date.now()
      return Promise.resolve(service.listInRange(now, now + d * DAY_MS))
    },
    'calendar.get_event': (id) => Promise.resolve(service.getEvent(String(id))),
    'calendar.create_local': (input) => Promise.resolve(service.createLocal(input as LocalEventInput)),
    'calendar.update_local': (id, patch) =>
      Promise.resolve(service.updateLocal(String(id), patch as Partial<LocalEventInput>)),
    'calendar.delete_local': (id) => Promise.resolve(service.deleteLocal(String(id))),
  }

  log.info({ msg: 'calendar IPC wired' })

  const channels = [
    'calendar:getStatus',
    'calendar:setClientCreds',
    'calendar:clearClientCreds',
    'calendar:linkAccount',
    'calendar:unlinkAccount',
    'calendar:syncNow',
    'calendar:listInRange',
    'calendar:createLocal',
    'calendar:updateLocal',
    'calendar:deleteLocal',
  ]
  return {
    dispose() {
      unsubscribe()
      for (const ch of channels) ipcMain.removeHandler(ch)
    },
    rpcHandlers,
  }
}
