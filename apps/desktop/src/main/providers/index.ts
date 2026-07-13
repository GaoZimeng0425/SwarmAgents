// src/main/providers/index.ts
//
// Entry point for the providers subsystem. Wires the on-disk store, the
// in-memory service, and the Electron IPC layer; must run after app.whenReady()
// and before any BrowserWindow is created so the first render sees state.
import { paths } from '../constants'
import { wireProvidersIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

export type ProvidersHandle = {
  service: Service
  dispose(): void
}

/**
 * Initialise the providers subsystem. Must be called after app.whenReady()
 * and BEFORE any BrowserWindow is created so the first render of the main
 * window already sees the current state.
 */
export async function initProviders(): Promise<ProvidersHandle> {
  const filePath = paths.providers()
  const store = createStore({ filePath })
  const service = await createService({ store })
  const { dispose } = wireProvidersIpc({ service })

  return { service, dispose }
}

export type { Service } from './service'
