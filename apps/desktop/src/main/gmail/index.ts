// src/main/gmail/index.ts
//
// Entry point for the Gmail subsystem. Wires the encrypted store, sqlite
// cache, REST client, OAuth auth, daemon, service, and IPC. Runs after
// app.whenReady(). registerMainRpc is called from main wiring once the
// ServiceClient exists.
import type { MainMethod } from '@swarm/protocol'

import { paths } from '../constants'
import { createGmailApi } from './api'
import { createAuth } from './auth'
import { createCache } from './cache'
import { createDaemon } from './daemon'
import { wireGmailIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

// Structural: only the registerMainRpc surface initGmail needs. The full
// ServiceClient type gains this method in a later task; importing it here
// would create a forward-dependency that fails typecheck until that lands.
type MainRpcClient = {
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}

export type GmailHandle = {
  service: Service
  registerMainRpc(client: MainRpcClient): void
  dispose(): void
}

export async function initGmail(): Promise<GmailHandle> {
  const store = createStore({ filePath: paths.gmail() })
  const cache = createCache({ filePath: paths.gmailDb() })
  const auth = createAuth({
    store,
    onProfile: async (token) => {
      const api = createGmailApi({
        getAccessToken: async () => token,
        refreshAccessToken: async () => {},
      })
      return api.getProfile()
    },
  })
  const api = createGmailApi(auth)
  const daemon = createDaemon({ api, cache })
  const service = await createService({ store, cache, auth, daemon, api })
  const wired = wireGmailIpc({ service })

  return {
    service,
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerMainRpc(method, wired.mainRpcHandlers[method]!)
      })
    },
    dispose() {
      wired.dispose()
      daemon.stop()
      cache.close()
    },
  }
}
