// src/main/calendar/index.ts
//
// Entry point for the Calendar subsystem. Mirrors gmail/index.ts. Runs after
// app.whenReady(); registerMainRpc is called from main wiring once the
// ServiceClient exists.
import type { MainMethod } from '@swarm/protocol'

import { paths } from '../constants'
import { createApi } from './api'
import { createAuth } from './auth'
import { createCache } from './cache'
import { createDaemon } from './daemon'
import { wireCalendarIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

type MainRpcClient = {
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}

export type CalendarHandle = {
  service: Service
  registerMainRpc(client: MainRpcClient): void
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
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerHandler(method, wired.mainRpcHandlers[method]!)
      })
    },
    dispose() {
      wired.dispose()
      daemon.stop()
      cache.close()
    },
  }
}
