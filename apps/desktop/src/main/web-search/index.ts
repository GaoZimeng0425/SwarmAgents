// src/main/web-search/index.ts
//
// Entry point for the web-search config subsystem. Wires the on-disk store,
// the in-memory service, and the Electron IPC layer. Runs after app.whenReady().
import { paths } from '../constants'
import { wireWebSearchIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

export type WebSearchHandle = {
  service: Service
  dispose(): void
}

export async function initWebSearch(): Promise<WebSearchHandle> {
  const filePath = paths.webSearch()
  const store = createStore({ filePath })
  const service = await createService({ store })
  const { dispose } = wireWebSearchIpc({ service })

  return { service, dispose }
}

export type { Service } from './service'
