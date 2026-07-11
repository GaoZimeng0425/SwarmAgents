// Wires the workbench subsystem to Electron IPC: task/column CRUD handlers
// plus a broadcast of the new state to all renderer windows on change.
// Input is validated with Zod schemas at the IPC boundary (untrusted renderer).
import { createLogger } from '@shared/logger'
import {
  AddColumnInputSchema,
  CreateTaskInputSchema,
  MoveTaskInputSchema,
  RenameColumnInputSchema,
  UpdateTaskInputSchema,
  type WorkbenchData,
} from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'workbench-ipc' })

const STATE_CHANGED_CHANNEL = 'workbench:stateChanged'

export function wireWorkbenchIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args

  const unsubscribe = service.onStateChanged((data) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED_CHANNEL, data)
    }
  })

  const channels: string[] = []

  const handle = <T>(
    channel: string,
    handler: (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T
  ): void => {
    ipcMain.handle(channel, handler)
    channels.push(channel)
  }

  handle('workbench:getAll', () => service.getAll())

  handle('workbench:createTask', (_e, input: unknown) => {
    const parsed = CreateTaskInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.createTask(parsed.data)
  })

  handle('workbench:updateTask', (_e, id: unknown, patch: unknown) => {
    const parsed = UpdateTaskInputSchema.safeParse(patch)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.updateTask(id as string, parsed.data)
  })

  handle('workbench:completeTask', (_e, id: unknown) => service.completeTask(id as string))
  handle('workbench:reopenTask', (_e, id: unknown) => service.reopenTask(id as string))
  handle('workbench:deleteTask', (_e, id: unknown) => service.deleteTask(id as string))

  handle('workbench:moveTask', (_e, input: unknown) => {
    const parsed = MoveTaskInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.moveTask(parsed.data)
  })

  handle('workbench:addColumn', (_e, input: unknown) => {
    const parsed = AddColumnInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.addColumn(parsed.data.name)
  })

  handle('workbench:renameColumn', (_e, input: unknown) => {
    const parsed = RenameColumnInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.renameColumn(parsed.data.id, parsed.data.name)
  })

  handle('workbench:deleteColumn', (_e, id: unknown) => service.deleteColumn(id as string))
  handle('workbench:reorderColumns', (_e, orderedIds: unknown) => service.reorderColumns(orderedIds as string[]))

  log.info({ msg: 'workbench IPC wired', channels })

  return {
    dispose(): void {
      unsubscribe()
      for (const ch of channels) ipcMain.removeHandler(ch)
    },
  }
}

/** Re-exported type so the IPC wiring file is the single import for callers. */
export type { WorkbenchData }
