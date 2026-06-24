// src/main/providers/ipc.ts
//
// Wires the providers subsystem to Electron IPC. Exposes get / setKey / clearKey
// / setActive / setModel / apiStyle / thinking / contextWindow / baseUrl /
// custom-model handlers, the custom-provider lifecycle (add/remove/rename), and
// a test handler. Broadcasts state changes to all renderer windows and fires a
// one-shot decrypt-failed event at boot when applicable.
import { createLogger } from '@shared/logger'
import { type ApiStyle, type ModelMeta, ModelThinkingLevel } from '@shared/types/provider'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'

import { fetchCatalog, lookupModel } from './openrouter'
import type { AddCustomInput, Service } from './service'
import { testConnection } from './test-connection'

const log = createLogger({ process: 'main' }).child({ component: 'providers-ipc' })

const STATE_CHANGED_CHANNEL = 'providers:stateChanged'
const DECRYPT_FAILED_CHANNEL = 'providers:decryptFailed'

// Any provider id (builtin 'anthropic'/'openai' or a custom uuid). The service
// rejects unknown ids; here we only guard the wire type.
function asId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null
}

const badId = { ok: false as const, code: 'invalid' as const, message: 'invalid provider id' }

export function wireProvidersIpc(args: { service: Service; decryptFailedAtBoot: boolean }): { dispose: () => void } {
  const { service, decryptFailedAtBoot } = args

  const broadcast = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  const unsubscribe = service.onStateChanged((view) => {
    broadcast(STATE_CHANGED_CHANNEL, view)
  })

  // One-shot at boot if applicable. Fired on any new window via did-finish-load.
  const fireDecryptIfNeeded = (w: BrowserWindow): void => {
    if (decryptFailedAtBoot && !w.isDestroyed()) w.webContents.send(DECRYPT_FAILED_CHANNEL)
  }
  const onWebContentsCreated = (_: Electron.Event, contents: Electron.WebContents): void => {
    contents.once('did-finish-load', () => {
      const w = BrowserWindow.fromWebContents(contents)
      if (w) fireDecryptIfNeeded(w)
    })
  }
  app.on('web-contents-created', onWebContentsCreated)
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => fireDecryptIfNeeded(w))
    else fireDecryptIfNeeded(w)
  }

  ipcMain.handle('providers:get', () => service.getView())

  ipcMain.handle('providers:setKey', (_e: Electron.IpcMainInvokeEvent, p: unknown, key: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof key !== 'string') return { ok: false, code: 'invalid', message: 'key must be a string' }
    return service.setKey(id, key)
  })

  ipcMain.handle('providers:clearKey', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    return id ? service.clearKey(id) : badId
  })

  ipcMain.handle('providers:setActive', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    if (p === null) return service.setActive(null)
    const id = asId(p)
    return id ? service.setActive(id) : badId
  })

  ipcMain.handle('providers:setModel', (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.setModel(id, model)
  })

  ipcMain.handle('providers:addCustomModel', (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.addCustomModel(id, model)
  })

  ipcMain.handle('providers:removeCustomModel', (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.removeCustomModel(id, model)
  })

  ipcMain.handle('providers:setApiStyle', (_e: Electron.IpcMainInvokeEvent, p: unknown, style: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (style !== 'anthropic' && style !== 'openai')
      return { ok: false, code: 'invalid', message: 'apiStyle must be "anthropic" or "openai"' }
    return service.setApiStyle(id, style)
  })

  ipcMain.handle('providers:setThinkingLevel', (_e: Electron.IpcMainInvokeEvent, p: unknown, level: unknown) => {
    const id = asId(p)
    if (!id) return badId
    const lvl = ModelThinkingLevel.safeParse(level)
    if (!lvl.success) return { ok: false, code: 'invalid', message: 'unknown thinking level' }
    return service.setThinkingLevel(id, lvl.data)
  })

  ipcMain.handle(
    'providers:setModelContextWindow',
    (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown, contextWindow: unknown) => {
      const id = asId(p)
      if (!id) return badId
      if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
      if (contextWindow !== null && typeof contextWindow !== 'number')
        return { ok: false, code: 'invalid', message: 'contextWindow must be a number or null' }
      return service.setModelContextWindow(id, model, contextWindow)
    }
  )

  ipcMain.handle('providers:fetchModelInfo', async (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    if (!id) return { ok: false as const, code: 'invalid' as const, message: 'invalid provider id' }
    const provider = service.getState().providers.find((x) => x.id === id)
    if (!provider) return { ok: false as const, code: 'invalid' as const, message: `unknown provider "${id}"` }
    if (provider.registry)
      return {
        ok: false as const,
        code: 'invalid' as const,
        message: 'OpenRouter fetch applies to custom providers only',
      }
    log.info({ msg: 'fetch model info', id, total: provider.models.length })
    let catalog: Awaited<ReturnType<typeof fetchCatalog>>
    try {
      catalog = await fetchCatalog()
    } catch (e) {
      log.error({ msg: 'fetch model info network failure', id, err: e instanceof Error ? e.message : String(e) })
      return { ok: false as const, code: 'network' as const, message: e instanceof Error ? e.message : String(e) }
    }
    const map: Record<string, ModelMeta> = {}
    const unmatched: string[] = []
    for (const m of provider.models) {
      const meta = lookupModel(catalog, m)
      if (meta) map[m] = meta
      else unmatched.push(m)
    }
    const r = await service.mergeModelMeta(id, map)
    if (!r.ok) return { ok: false as const, code: 'invalid' as const, message: r.message }
    if (unmatched.length) log.warn({ msg: 'models unmatched on openrouter', id, unmatched })
    const matched = provider.models.length - unmatched.length
    log.info({ msg: 'fetch model info done', id, matched, total: provider.models.length })
    return { ok: true as const, matched, total: provider.models.length, unmatched }
  })

  ipcMain.handle('providers:setBaseUrl', (_e: Electron.IpcMainInvokeEvent, p: unknown, baseUrl: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (baseUrl !== null && typeof baseUrl !== 'string')
      return { ok: false, code: 'invalid', message: 'baseUrl must be a string or null' }
    return service.setBaseUrl(id, baseUrl)
  })

  ipcMain.handle('providers:addCustomProvider', (_e: Electron.IpcMainInvokeEvent, input: unknown) => {
    if (!input || typeof input !== 'object') return { ok: false, code: 'invalid', message: 'input must be an object' }
    const i = input as Partial<AddCustomInput>
    if (typeof i.name !== 'string' || typeof i.apiKey !== 'string')
      return { ok: false, code: 'invalid', message: 'name and apiKey are required' }
    if (i.apiStyle !== 'anthropic' && i.apiStyle !== 'openai')
      return { ok: false, code: 'invalid', message: 'apiStyle must be "anthropic" or "openai"' }
    if (!Array.isArray(i.models) || i.models.some((m) => typeof m !== 'string'))
      return { ok: false, code: 'invalid', message: 'models must be an array of strings' }
    return service.addCustomProvider({
      name: i.name,
      apiKey: i.apiKey,
      apiStyle: i.apiStyle as ApiStyle,
      baseUrl: typeof i.baseUrl === 'string' ? i.baseUrl : null,
      models: i.models as string[],
      ...(i.thinkingLevel ? { thinkingLevel: i.thinkingLevel } : {}),
    })
  })

  ipcMain.handle('providers:removeCustomProvider', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    return id ? service.removeCustomProvider(id) : badId
  })

  ipcMain.handle('providers:renameCustomProvider', (_e: Electron.IpcMainInvokeEvent, p: unknown, name: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof name !== 'string') return { ok: false, code: 'invalid', message: 'name must be a string' }
    return service.renameCustomProvider(id, name)
  })

  ipcMain.handle('providers:test', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    if (!id) return { ok: false, code: 'unknown', message: 'invalid provider id' }
    const provider = service.getState().providers.find((x) => x.id === id)
    if (!provider) return { ok: false, code: 'no_key', message: 'no key configured' }
    return testConnection({
      id: provider.id,
      ...(provider.registry ? { registry: provider.registry } : {}),
      apiStyle: provider.apiStyle,
      model: provider.model,
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    })
  })

  log.info({ msg: 'providers IPC wired', decryptFailedAtBoot })

  const channels = [
    'providers:get',
    'providers:setKey',
    'providers:clearKey',
    'providers:setActive',
    'providers:setModel',
    'providers:addCustomModel',
    'providers:removeCustomModel',
    'providers:setApiStyle',
    'providers:setThinkingLevel',
    'providers:setModelContextWindow',
    'providers:fetchModelInfo',
    'providers:setBaseUrl',
    'providers:addCustomProvider',
    'providers:removeCustomProvider',
    'providers:renameCustomProvider',
    'providers:test',
  ]

  return {
    dispose(): void {
      unsubscribe()
      app.off('web-contents-created', onWebContentsCreated)
      for (const c of channels) ipcMain.removeHandler(c)
    },
  }
}

// Helper used by main entry to check whether safeStorage will work at all.
export function safeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
