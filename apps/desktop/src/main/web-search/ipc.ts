// src/main/web-search/ipc.ts
//
// Wires the web-search config subsystem to Electron IPC. Exposes get / setProvider
// / setKey / clearKey / setSearxngUrl handlers and broadcasts state changes (the
// redacted view) to all renderer windows.
import { createLogger } from '@shared/logger'
import { WebSearchProviderId } from '@swarm/protocol'

import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import type { KeyId, Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'web-search-ipc' })

function asKeyId(v: unknown): KeyId | null {
  return v === 'tavily' || v === 'brave' ? v : null
}

export function wireWebSearchIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args
  const ipc = createIpcRegistrar()

  const unsubscribe = service.onStateChanged((view) => {
    sendToAllWindows('webSearch:stateChanged', view)
  })

  ipc.handle('webSearch:get', () => service.getView())

  ipc.handle('webSearch:setProvider', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const pid = WebSearchProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    return service.setProvider(pid.data)
  })

  ipc.handle('webSearch:setKey', (_e: Electron.IpcMainInvokeEvent, id: unknown, key: unknown) => {
    const kid = asKeyId(id)
    if (!kid) return { ok: false, code: 'invalid', message: 'unknown key id' }
    if (typeof key !== 'string') return { ok: false, code: 'invalid', message: 'key must be a string' }
    return service.setKey(kid, key)
  })

  ipc.handle('webSearch:clearKey', (_e: Electron.IpcMainInvokeEvent, id: unknown) => {
    const kid = asKeyId(id)
    if (!kid) return { ok: false, code: 'invalid', message: 'unknown key id' }
    return service.clearKey(kid)
  })

  ipc.handle('webSearch:setSearxngUrl', (_e: Electron.IpcMainInvokeEvent, url: unknown) => {
    if (url !== null && typeof url !== 'string')
      return { ok: false, code: 'invalid', message: 'url must be a string or null' }
    return service.setSearxngUrl(url)
  })

  log.info({ msg: 'web-search IPC wired' })

  return {
    dispose(): void {
      unsubscribe()
      ipc.dispose()
    },
  }
}
