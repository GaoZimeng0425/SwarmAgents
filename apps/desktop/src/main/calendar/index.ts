// src/main/calendar/index.ts
//
// Entry point for the Calendar subsystem. Mirrors gmail/index.ts. Runs after
// app.whenReady(); registerRpcHandlers is called from main wiring once the
// ServiceClient exists.
import type { MainMethod, MainMethodSignatures } from '@swarm/protocol'

import { paths } from '../constants'
import { createApi } from './api'
import { createAuth } from './auth'
import { createCache } from './cache'
import { createDaemon } from './daemon'
import { wireCalendarIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

// Structural: mirrors ServiceClient['registerHandler'], table-derived from
// MainMethodSignatures (see gmail/index.ts).
type RpcHandlerClient = {
  registerHandler<M extends MainMethod>(
    method: M,
    fn: (...args: MainMethodSignatures[M]['args']) => unknown | Promise<unknown>
  ): void
}

export type CalendarHandle = {
  service: Service
  registerRpcHandlers(client: RpcHandlerClient): void
  dispose(): void
}

export async function initCalendar(): Promise<CalendarHandle> {
  const store = createStore({ filePath: paths.calendar() })
  const cache = createCache({ filePath: paths.calendarDb() })
  const auth = createAuth({
    store,
    onProfile: async (token) => {
      // The primary calendar id IS the user's email address.
      const api = createApi({ getAccessToken: async () => token, refreshAccessToken: async () => {} })
      const emailAddress = await api.getPrimaryCalendarEmail()
      return { emailAddress }
    },
  })
  const api = createApi(auth)
  const daemon = createDaemon({ api, cache })
  const service = await createService({ store, cache, auth, daemon })
  const wired = wireCalendarIpc({ service })

  return {
    service,
    registerRpcHandlers(client) {
      ;(Object.keys(wired.rpcHandlers) as Array<keyof typeof wired.rpcHandlers>).forEach((method) => {
        // Correlated-union call: TS cannot prove wired.rpcHandlers[method] accepts
        // registerHandler's per-method arg tuple for the same M — the single
        // documented cast at the choke point (mirrors service/ipc/dispatcher.ts).
        client.registerHandler(method, wired.rpcHandlers[method] as (...args: unknown[]) => Promise<unknown>)
      })
    },
    dispose() {
      wired.dispose()
      daemon.stop()
      cache.close()
    },
  }
}
