// src/main/web-search/index.ts
//
// Entry point for the web-search config subsystem. Wires the encrypted store,
// the in-memory service, and the Electron IPC layer. Runs after app.whenReady()
// (and after initProviders, which already guarantees safeStorage is available).
import { createLogger } from '@shared/logger'

import { paths } from '../constants'
import { wireWebSearchIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'web-search' })

export type WebSearchHandle = {
  service: Service
  dispose(): void
}

export async function initWebSearch(): Promise<WebSearchHandle> {
  const filePath = paths.webSearch()
  const store = createStore({ filePath })
  const loaded = await store.loadOrRecover()
  if (!loaded.ok) {
    // Defaults are used (store.load is forgiving); surface why for the log file.
    log.warn({ msg: 'web-search config load failed at boot, using defaults', reason: loaded.reason })
  }

  const service = await createService({ store })
  const { dispose } = wireWebSearchIpc({ service })

  return { service, dispose }
}

export type { Service } from './service'
