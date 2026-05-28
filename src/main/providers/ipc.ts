// src/main/providers/ipc.ts
//
// Wires the providers subsystem to Electron IPC. Exposes get/setKey/clearKey/
// setActive/setModel/test handlers, broadcasts state changes to all renderer
// windows, and fires a one-shot decrypt-failed event at boot when applicable.

import { createLogger } from '@shared/logger'
import { ProviderId } from '@shared/types/provider'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'

import type { Service } from './service'
import { testConnection } from './test-connection'

const log = createLogger({ process: 'main' }).child({ component: 'providers-ipc' })

const STATE_CHANGED_CHANNEL = 'providers:stateChanged'
const DECRYPT_FAILED_CHANNEL = 'providers:decryptFailed'

export function wireProvidersIpc(args: { service: Service; decryptFailedAtBoot: boolean }): { dispose: () => void } {
  const { service, decryptFailedAtBoot } = args

  const broadcast = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }

  // Push state changes to every renderer window.
  const unsubscribe = service.onStateChanged((view) => {
    broadcast(STATE_CHANGED_CHANNEL, view)
  })

  // One-shot at boot if applicable. Fired on any new window via did-finish-load.
  const fireDecryptIfNeeded = (w: BrowserWindow): void => {
    if (decryptFailedAtBoot && !w.isDestroyed()) {
      w.webContents.send(DECRYPT_FAILED_CHANNEL)
    }
  }
  const onWebContentsCreated = (_: Electron.Event, contents: Electron.WebContents): void => {
    contents.once('did-finish-load', () => {
      const w = BrowserWindow.fromWebContents(contents)
      if (w) fireDecryptIfNeeded(w)
    })
  }
  app.on('web-contents-created', onWebContentsCreated)
  // Cover already-open windows
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', () => fireDecryptIfNeeded(w))
    } else {
      fireDecryptIfNeeded(w)
    }
  }

  const get = (): unknown => service.getView()
  ipcMain.handle('providers:get', get)

  const setKey = async (_: Electron.IpcMainInvokeEvent, p: unknown, key: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (typeof key !== 'string') return { ok: false, code: 'invalid', message: 'key must be a string' }
    return service.setKey(pid.data, key)
  }
  ipcMain.handle('providers:setKey', setKey)

  const clearKey = async (_: Electron.IpcMainInvokeEvent, p: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    return service.clearKey(pid.data)
  }
  ipcMain.handle('providers:clearKey', clearKey)

  const setActive = async (_: Electron.IpcMainInvokeEvent, p: unknown) => {
    if (p === null) return service.setActive(null)
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    return service.setActive(pid.data)
  }
  ipcMain.handle('providers:setActive', setActive)

  const setModel = async (_: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.setModel(pid.data, model)
  }
  ipcMain.handle('providers:setModel', setModel)

  const addCustomModel = async (_: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.addCustomModel(pid.data, model)
  }
  ipcMain.handle('providers:addCustomModel', addCustomModel)

  const removeCustomModel = async (_: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.removeCustomModel(pid.data, model)
  }
  ipcMain.handle('providers:removeCustomModel', removeCustomModel)

  const setApiStyle = async (_: Electron.IpcMainInvokeEvent, p: unknown, style: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (style !== 'anthropic' && style !== 'openai')
      return { ok: false, code: 'invalid', message: 'apiStyle must be "anthropic" or "openai"' }
    return service.setApiStyle(pid.data, style)
  }
  ipcMain.handle('providers:setApiStyle', setApiStyle)

  const setBaseUrl = async (_: Electron.IpcMainInvokeEvent, p: unknown, baseUrl: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'invalid', message: 'unknown provider id' }
    if (baseUrl !== null && typeof baseUrl !== 'string')
      return { ok: false, code: 'invalid', message: 'baseUrl must be a string or null' }
    return service.setBaseUrl(pid.data, baseUrl)
  }
  ipcMain.handle('providers:setBaseUrl', setBaseUrl)

  const test = async (_: Electron.IpcMainInvokeEvent, p: unknown) => {
    const pid = ProviderId.safeParse(p)
    if (!pid.success) return { ok: false, code: 'unknown', message: 'unknown provider id' }
    const state = service.getState()
    const row = state.providers[pid.data]
    if (!row) return { ok: false, code: 'no_key', message: 'no key configured' }
    return testConnection({
      id: pid.data,
      model: row.model,
      apiKey: row.apiKey,
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      // Without apiStyle, a custom row configured for Anthropic-compatible
      // endpoints would be tested with an OpenAI-style POST — false positive
      // for the user, mismatched with what the worker actually does at
      // chat-time (which DOES use the saved apiStyle via getInjection()).
      ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
    })
  }
  ipcMain.handle('providers:test', test)

  log.info({ msg: 'providers IPC wired', decryptFailedAtBoot })

  return {
    dispose(): void {
      unsubscribe()
      app.off('web-contents-created', onWebContentsCreated)
      ipcMain.removeHandler('providers:get')
      ipcMain.removeHandler('providers:setKey')
      ipcMain.removeHandler('providers:clearKey')
      ipcMain.removeHandler('providers:setActive')
      ipcMain.removeHandler('providers:setModel')
      ipcMain.removeHandler('providers:setApiStyle')
      ipcMain.removeHandler('providers:setBaseUrl')
      ipcMain.removeHandler('providers:addCustomModel')
      ipcMain.removeHandler('providers:removeCustomModel')
      ipcMain.removeHandler('providers:test')
    },
  }
}

// Helper used by main entry to check whether safeStorage will work at all.
export function safeStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
