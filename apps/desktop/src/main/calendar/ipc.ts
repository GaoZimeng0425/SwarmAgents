// src/main/calendar/ipc.ts
//
// Wires the Calendar service to Electron IPC (renderer handlers) and exposes
// the main-rpc query/CRUD handlers the service->main bridge dispatches to.
// Mirrors gmail/ipc.ts; broadcasts calendar:stateChanged to all windows.
import { createLogger } from '@shared/logger'
import type { CalendarClientCreds, MainMethod, MainMethodSignatures } from '@swarm/protocol'

import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import type { LocalEventInput } from './cache'
import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-ipc' })

type CalendarMethod = Extract<MainMethod, `calendar.${string}`>
export type RpcHandlers = {
  [M in CalendarMethod]: (...args: MainMethodSignatures[M]['args']) => Promise<unknown>
}

export function wireCalendarIpc(args: { service: Service }): {
  dispose: () => void
  rpcHandlers: RpcHandlers
} {
  const { service } = args
  const ipc = createIpcRegistrar()

  const unsubscribe = service.onStateChanged((view) => {
    sendToAllWindows('calendar:stateChanged', view)
  })

  ipc.handle('calendar:getStatus', () => service.getView())
  ipc.handle('calendar:setClientCreds', (_e, creds: CalendarClientCreds) => service.setClientCreds(creds))
  ipc.handle('calendar:clearClientCreds', () => service.clearClientCreds())
  ipc.handle('calendar:linkAccount', () => service.linkAccount())
  ipc.handle('calendar:unlinkAccount', () => service.unlinkAccount())
  ipc.handle('calendar:syncNow', () => service.syncNow())
  ipc.handle('calendar:listInRange', (_e, fromMs: number, toMs: number) =>
    service.listInRange(Number(fromMs), Number(toMs))
  )
  ipc.handle('calendar:createLocal', (_e, input: LocalEventInput) => service.createLocal(input))
  ipc.handle('calendar:updateLocal', (_e, id: string, patch: Partial<LocalEventInput>) =>
    service.updateLocal(String(id), patch)
  )
  ipc.handle('calendar:deleteLocal', (_e, id: string) => service.deleteLocal(String(id)))

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

  return {
    dispose() {
      unsubscribe()
      ipc.dispose()
    },
    rpcHandlers,
  }
}
