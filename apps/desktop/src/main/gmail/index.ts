// src/main/gmail/index.ts
//
// Entry point for the Gmail subsystem. Wires the on-disk store, sqlite
// cache, REST client, OAuth auth, daemon, service, and IPC. Runs after
// app.whenReady(). registerRpcHandlers is called from main wiring once the
// ServiceClient exists.
import type { MainMethod, MainMethodSignatures } from '@swarm/protocol'

import { paths } from '../constants'
import { createGmailApi } from './api'
import { createAuth } from './auth'
import { createCache } from './cache'
import { createDaemon } from './daemon'
import { wireGmailIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

// Structural: only the registerRpcHandlers surface initGmail needs (avoids a
// forward-dependency on the full ServiceClient type). Signature mirrors
// ServiceClient['registerHandler'], table-derived from MainMethodSignatures.
type RpcHandlerClient = {
  registerHandler<M extends MainMethod>(
    method: M,
    fn: (...args: MainMethodSignatures[M]['args']) => unknown | Promise<unknown>
  ): void
}

export type GmailHandle = {
  service: Service
  registerRpcHandlers(client: RpcHandlerClient): void
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
