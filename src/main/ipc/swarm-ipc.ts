import { BrowserWindow, ipcMain } from 'electron'
import { ulid } from 'ulid'

import { createLogger } from '@shared/logger'
import type { Task } from '@shared/types/task'
import type { PermissionDecision, UIEvent } from '@shared/types/ui'
import { ConfirmRequestSchema, type ConfirmRequest, type ConfirmResponse } from '@shared/types/ipc'

import type { PermissionGate, PermissionRequest } from '../permission/gate'
import type { Service as ProvidersService } from '../providers'
import { getAccent, subscribeAccent } from '../system/accent'
import { showNativeConfirm } from '../system/confirm'
import type { Supervisor } from '../supervisor'
import { getMainWindow } from '../windows/main-window'
import { openSettings } from '../windows/settings-window'

const EVENT_CHANNEL = 'swarm:event'
const log = createLogger({ process: 'main' }).child({ component: 'swarm-ipc' })

type PendingPermission = {
  resolve: (d: PermissionDecision) => void
  taskId: string
  timer: NodeJS.Timeout
}

const DEFAULT_BUDGET = { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 } as const
const EMPTY_USED = { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 } as const

export function wireSwarmIpc(args: {
  supervisor: Supervisor
  permissionGate: PermissionGate
  providers: ProvidersService
}): { dispose: () => void } {
  const { supervisor, permissionGate, providers } = args

  // Broadcast a UI event to every open window.
  const broadcast = (event: UIEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, event)
    }
  }

  // Pending permission prompts, keyed by actionId, awaiting renderer decision.
  const pendingPermissions = new Map<string, PendingPermission>()

  // Wire permission gate prompt handler — push a UI event, await the
  // matching decideEvent from renderer.
  permissionGate.setPromptHandler(
    (req: PermissionRequest) =>
      new Promise<PermissionDecision>((resolve) => {
        const timer = setTimeout(() => {
          const pending = pendingPermissions.get(req.actionId)
          if (pending) {
            pendingPermissions.delete(req.actionId)
            log.warn({ msg: 'permission timeout', actionId: req.actionId })
            resolve('deny')
          }
        }, 30_000)
        pendingPermissions.set(req.actionId, { resolve, taskId: req.taskId, timer })
        broadcast({
          kind: 'task.permission_request',
          taskId: req.taskId,
          workerId: 'unknown',
          actionId: req.actionId,
          risk: req.risk,
          summary: req.summary,
          payload: req.payload,
          ts: Date.now(),
        })
      }),
  )

  // ---- Supervisor → UI event bridge ----

  supervisor.on('task.dispatched', (taskId, workerId) => {
    broadcast({ kind: 'task.dispatched', taskId, workerId, ts: Date.now() })
  })

  supervisor.on('progress', (taskId, msg) => {
    broadcast({ kind: 'task.progress', taskId, event: msg.event, ts: Date.now() })
  })

  supervisor.on('tool.call', (taskId, workerId, msg) => {
    broadcast({
      kind: 'task.tool_call',
      taskId,
      workerId,
      tool: `${msg.server}.${msg.tool}`,
      args: msg.args,
      ts: Date.now(),
    })
  })

  supervisor.on('permission.request', (taskId, workerId, msg) => {
    // The supervisor's permission.request event also goes through the gate
    // (which emits the broadcast). But we still want workerId attached for
    // the UI, so we replay with the right workerId.
    broadcast({
      kind: 'task.permission_request',
      taskId,
      workerId,
      actionId: msg.actionId,
      risk: msg.risk,
      summary: msg.summary,
      payload: msg.payload,
      ts: Date.now(),
    })
  })

  supervisor.on('task.complete', (taskId, result) => {
    broadcast({
      kind: 'task.complete',
      taskId,
      summary: result.result.summary,
      ts: Date.now(),
    })
  })

  supervisor.on('task.error', (taskId, error) => {
    broadcast({ kind: 'task.error', taskId, error, ts: Date.now() })
  })

  // ---- Renderer → Main RPC handlers ----

  const submitGoal = (_e: Electron.IpcMainInvokeEvent, goal: string): { taskId: string } => {
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
      broadcast({ kind: 'task.created', taskId, goal: trimmedGoal, ts: now })
      broadcast({
        kind: 'task.error',
        taskId,
        error: {
          code: 'no_provider',
          message: 'Configure an API key in Settings before starting tasks.',
          tier: 'fatal',
        },
        ts: now,
      })
      log.warn({ msg: 'submit rejected: no active provider', taskId })
      return { taskId }
    }
    const task: Task = {
      id: taskId,
      parentId: null,
      goal: trimmedGoal,
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: ['peekaboo.*', 'web.*', 'fs.*'],
      budget: { ...DEFAULT_BUDGET },
      used: { ...EMPTY_USED },
      history: [],
      result: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    }
    broadcast({ kind: 'task.created', taskId, goal: task.goal, ts: now })
    supervisor.dispatch(task, injection)
    log.info({ msg: 'task submitted', taskId, goal: task.goal, provider: injection.id })
    return { taskId }
  }

  const cancelTask = (_e: Electron.IpcMainInvokeEvent, taskId: string): void => {
    // For Phase A: cancellation routes to worker by tying through the
    // task.cancel inbound. We don't track which worker owns the task here;
    // a future iteration will lift task → worker mapping. For now we no-op
    // and let the worker finish.
    log.info({ msg: 'cancelTask requested (not yet implemented)', taskId })
  }

  const decidePermission = (
    _e: Electron.IpcMainInvokeEvent,
    actionId: string,
    decision: PermissionDecision,
  ): void => {
    const pending = pendingPermissions.get(actionId)
    if (!pending) {
      log.warn({ msg: 'no pending permission for actionId', actionId })
      return
    }
    clearTimeout(pending.timer)
    pendingPermissions.delete(actionId)
    pending.resolve(decision)
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

  const handleShowConfirm = async (
    _e: Electron.IpcMainInvokeEvent,
    raw: unknown,
  ): Promise<ConfirmResponse> => {
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
      for (const p of pendingPermissions.values()) {
        clearTimeout(p.timer)
        p.resolve('deny')
      }
      pendingPermissions.clear()
    },
  }
}
