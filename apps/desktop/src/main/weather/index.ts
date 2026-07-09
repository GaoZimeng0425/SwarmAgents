// Entry point for the QWeather subsystem. Wires the encrypted store, the
// in-memory service, and the Electron IPC layer. Runs after app.whenReady()
// (safeStorage is available by then — providers/gmail already rely on it).
import { createLogger } from '@shared/logger'
import type { MainMethod } from '@swarm/protocol'

import { paths } from '../constants'
import { wireWeatherIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'weather' })

type MainRpcClient = {
  registerMainRpc(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}

export type WeatherHandle = {
  service: Service
  registerMainRpc(client: MainRpcClient): void
  dispose(): void
}

export async function initWeather(): Promise<WeatherHandle> {
  const filePath = paths.weather()
  const store = createStore({ filePath })
  const loaded = await store.loadOrRecover()
  if (!loaded.ok) {
    log.warn({ msg: 'weather config load failed at boot, using defaults', reason: loaded.reason })
  }

  const service = await createService({ store })
  const wired = wireWeatherIpc({ service })

  return {
    service,
    registerMainRpc(client) {
      ;(Object.keys(wired.mainRpcHandlers) as Array<keyof typeof wired.mainRpcHandlers>).forEach((method) => {
        client.registerMainRpc(method, wired.mainRpcHandlers[method]!)
      })
    },
    dispose() {
      wired.dispose()
    },
  }
}

export type { Service } from './service'
