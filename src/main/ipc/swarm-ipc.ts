import { createLogger } from '@shared/logger'
import { type ConfirmRequest, ConfirmRequestSchema, type ConfirmResponse } from '@shared/types/ipc'
import { BrowserWindow, ipcMain } from 'electron'
import { ulid } from 'ulid'

import type { ServiceClient } from '../service-client'
import type { Service as ProvidersService } from '../providers'
import { getAccent, subscribeAccent } from '../system/accent'
import { showNativeConfirm } from '../system/confirm'
import { getMainWindow } from '../windows/main-window'
import { openSettings } from '../windows/settings-window'

const log = createLogger({ process: 'main' }).child({ component: 'swarm-ipc' })

export function wireSwarmIpc(args: {
  serviceClient: ServiceClient
  providers: ProvidersService
}): { dispose: () => void } {
  const { serviceClient, providers } = args

  // One global session per provider (simple initial approach); created lazily.
  let currentSessionId: string | null = null

  // ---- Renderer → Main RPC handlers ----

  const submitGoal = async (_e: Electron.IpcMainInvokeEvent, goal: string): Promise<{ taskId: string }> => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('goal must be a non-empty string')
    }
    const taskId = ulid()
    const now = Date.now()
    const trimmedGoal = goal.trim()
    const injection = providers.getInjection()
    if (!injection) {
      // Defense-in-depth: the main-window banner should make this unreachable,
      // but a race between state-change and click can land here. Surface a
      // typed task.error event so the timeline shows the failed task, instead
      // of throwing a generic IPC rejection the renderer can't classify.
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send('swarm:event', { kind: 'task.created', taskId, goal: trimmedGoal, ts: now })
          w.webContents.send('swarm:event', {
            kind: 'task.error',
            taskId,
            error: {
              code: 'no_provider',
              message: 'Configure an API key in Settings before starting tasks.',
              tier: 'fatal',
            },
            ts: now,
          })
        }
      }
      log.warn({ msg: 'submit rejected: no active provider', taskId })
      return { taskId }
    }

    if (!currentSessionId) {
      const { sessionId } = await serviceClient.createSession(injection)
      currentSessionId = sessionId
    }
    void serviceClient.submitGoal(currentSessionId, trimmedGoal)
    log.info({ msg: 'task submitted', taskId, goal: trimmedGoal, provider: injection.id })
    return { taskId }
  }

  const cancelTask = async (_e: Electron.IpcMainInvokeEvent, taskId: string): Promise<void> => {
    if (currentSessionId) {
      await serviceClient.cancelTask(currentSessionId, taskId)
    }
    log.info({ msg: 'cancelTask requested', taskId })
  }

  const decidePermission = (_e: Electron.IpcMainInvokeEvent, actionId: string, decision: string): void => {
    if (!currentSessionId) {
      log.warn({ msg: 'no active session for decidePermission', actionId })
      return
    }
    void serviceClient.decidePermission(currentSessionId, actionId, decision as import('@shared/types/ui').PermissionDecision)
    log.info({ msg: 'permission decided', actionId, decision })
  }

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

  return {
    dispose(): void {
      ipcMain.removeHandler('system:openSettings')
      ipcMain.removeHandler('system:showConfirm')
      ipcMain.removeHandler('system:getAccent')
      unsubscribeAccent()
      ipcMain.removeHandler('swarm:submitGoal')
      ipcMain.removeHandler('swarm:cancelTask')
      ipcMain.removeHandler('swarm:decidePermission')
    },
  }
}
