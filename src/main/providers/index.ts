// src/main/providers/index.ts
//
// Entry point for the providers subsystem. Wires the on-disk store, the
// in-memory service, and the Electron IPC layer; must run after app.whenReady()
// and before any BrowserWindow is created so the first render sees state.
import { createLogger } from '@shared/logger'
import { app, dialog } from 'electron'

import { paths } from '../constants'
import { safeStorageAvailable, wireProvidersIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'providers' })

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
  if (!safeStorageAvailable()) {
    dialog.showErrorBox(
      'Secure storage unavailable',
      'SwarmAgents cannot start because the operating system did not provide an encrypted storage backend. On macOS this usually means the Keychain is locked or inaccessible.'
    )
    app.quit()
    throw new Error('safeStorage unavailable')
  }

  const filePath = paths.providers()
  const store = createStore({ filePath })
  const loadResult = await store.loadOrRecover()
  const decryptFailedAtBoot = !loadResult.ok

  if (!loadResult.ok) {
    log.warn({ msg: 'providers load failed at boot', reason: loadResult.reason })
  }

  const service = await createService({ store })
  const { dispose } = wireProvidersIpc({ service, decryptFailedAtBoot })

  return { service, dispose }
}

export type { Service } from './service'
