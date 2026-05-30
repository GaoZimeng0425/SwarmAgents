import { createLogger } from '@shared/logger'
import { type ConfirmRequest, ConfirmRequestSchema, type ConfirmResponse } from '@shared/types/ipc'
import { BrowserWindow, ipcMain } from 'electron'

import type { ServiceClient } from '../service-client'
import type { Service as ProvidersService } from '../providers'
import { getAccent, subscribeAccent } from '../system/accent'
import { showNativeConfirm } from '../system/confirm'
import { getMacPermissions, openPrivacySettings } from '../system/permissions'
import { getMainWindow } from '../windows/main-window'
import { openSettings } from '../windows/settings-window'

const log = createLogger({ process: 'main' }).child({ component: 'swarm-ipc' })

export function wireSwarmIpc(args: {
  serviceClient: ServiceClient
  providers: ProvidersService
}): { dispose: () => void } {
  const { serviceClient, providers } = args

  // ---- Renderer → Main RPC handlers ----

  const createSession = async (): Promise<{ sessionId: string }> => {
    const injection = providers.getInjection()
    if (!injection) throw new Error('Configure an API key in Settings before starting a chat.')
    const { sessionId } = await serviceClient.createSession(injection)
    log.info({ msg: 'session created', sessionId, provider: injection.id })
    return { sessionId }
  }

  const listSessions = (): Promise<import('@shared/types/ui').SessionSummary[]> => serviceClient.listSessions()

  const getSessionTasks = (_e: Electron.IpcMainInvokeEvent, sessionId: string) =>
    serviceClient.getSessionTasks(sessionId)

  const submitGoal = async (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    goal: string,
  ): Promise<{ taskId: string }> => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal must be a non-empty string')
    }
    const trimmedGoal = goal.trim()
    const { taskId } = await serviceClient.submitGoal(sessionId, trimmedGoal)
    log.info({ msg: 'task submitted', sessionId, taskId })
    return { taskId }
  }

  const cancelTask = async (_e: Electron.IpcMainInvokeEvent, sessionId: string, taskId: string): Promise<void> => {
    try {
      await serviceClient.cancelTask(sessionId, taskId)
      log.info({ msg: 'cancelTask requested', sessionId, taskId })
    } catch (err) {
      log.warn({ msg: 'cancelTask failed', sessionId, taskId, err: String(err) })
    }
  }

  const decidePermission = (
    _e: Electron.IpcMainInvokeEvent,
    sessionId: string,
    actionId: string,
    decision: string,
  ): void => {
    void serviceClient
      .decidePermission(sessionId, actionId, decision as import('@shared/types/ui').PermissionDecision)
      .catch((err: unknown) => log.warn({ msg: 'decidePermission failed', err: String(err) }))
    log.info({ msg: 'permission decided', sessionId, actionId, decision })
  }

  ipcMain.handle('swarm:createSession', () => createSession())
  ipcMain.handle('swarm:listSessions', () => listSessions())
  ipcMain.handle('swarm:getSessionTasks', getSessionTasks)
  ipcMain.handle('swarm:submitGoal', submitGoal)
  ipcMain.handle('swarm:cancelTask', cancelTask)
  ipcMain.handle('swarm:decidePermission', decidePermission)

  const handleGetAccent = (): string | null => getAccent()
  ipcMain.handle('system:getAccent', handleGetAccent)

  const ACCENT_CHANGE_CHANNEL = 'system:accentChange'
  const unsubscribeAccent = subscribeAccent((hex) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(ACCENT_CHANGE_CHANNEL, { hex })
    }
  })

  const handleShowConfirm = async (_e: Electron.IpcMainInvokeEvent, raw: unknown): Promise<ConfirmResponse> => {
    const req: ConfirmRequest = ConfirmRequestSchema.parse(raw)
    const parent = getMainWindow()
    if (!parent) return 'deny'
    return showNativeConfirm(parent, req)
  }
  ipcMain.handle('system:showConfirm', handleShowConfirm)

  const handleOpenSettings = (_: Electron.IpcMainInvokeEvent, opts?: unknown): void => {
    let initialRoute: string | undefined
    if (
      opts &&
      typeof opts === 'object' &&
      'initialRoute' in opts &&
      typeof (opts as { initialRoute?: unknown }).initialRoute === 'string'
    ) {
      initialRoute = (opts as { initialRoute: string }).initialRoute
    }
    openSettings(initialRoute ? { initialRoute } : {})
  }
  ipcMain.handle('system:openSettings', handleOpenSettings)

  ipcMain.handle('system:getMacPermissions', () => getMacPermissions())
  const handleOpenPrivacySettings = (_e: Electron.IpcMainInvokeEvent, pane: unknown): Promise<void> =>
    openPrivacySettings(pane === 'accessibility' ? 'accessibility' : 'screen')
  ipcMain.handle('system:openPrivacySettings', handleOpenPrivacySettings)

  return {
    dispose(): void {
      ipcMain.removeHandler('system:openPrivacySettings')
      ipcMain.removeHandler('system:getMacPermissions')
      ipcMain.removeHandler('system:openSettings')
      ipcMain.removeHandler('system:showConfirm')
      ipcMain.removeHandler('system:getAccent')
      unsubscribeAccent()
      ipcMain.removeHandler('swarm:createSession')
      ipcMain.removeHandler('swarm:listSessions')
      ipcMain.removeHandler('swarm:getSessionTasks')
      ipcMain.removeHandler('swarm:submitGoal')
      ipcMain.removeHandler('swarm:cancelTask')
      ipcMain.removeHandler('swarm:decidePermission')
    },
  }
}
