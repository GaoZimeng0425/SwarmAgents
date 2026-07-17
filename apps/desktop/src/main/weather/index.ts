// Entry point for the QWeather subsystem. Wires the on-disk store, the
// in-memory service, and the Electron IPC layer. Runs after app.whenReady().
import type { MainMethod, MainMethodSignatures } from '@swarm/protocol'

import { paths } from '../constants'
import { wireWeatherIpc } from './ipc'
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

export type WeatherHandle = {
  service: Service
  registerRpcHandlers(client: RpcHandlerClient): void
  dispose(): void
}

export async function initWeather(): Promise<WeatherHandle> {
  const filePath = paths.weather()
  const store = createStore({ filePath })
  const service = await createService({ store, cachePath: paths.weatherCache() })
  const wired = wireWeatherIpc({ service })

  return {
    service,
    registerRpcHandlers(client) {
      ;(Object.keys(wired.rpcHandlers) as Array<keyof typeof wired.rpcHandlers>).forEach((method) => {
        client.registerHandler(method, wired.rpcHandlers[method]!)
      })
    },
    dispose() {
      wired.dispose()
    },
  }
}

export type { Service } from './service'
