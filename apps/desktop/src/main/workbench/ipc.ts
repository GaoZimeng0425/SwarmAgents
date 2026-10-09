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

import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'workbench-ipc' })

export function wireWorkbenchIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args
  const ipc = createIpcRegistrar()

  const unsubscribe = service.onStateChanged((data) => {
    sendToAllWindows('workbench:stateChanged', data)
  })

  ipc.handle('workbench:getAll', () => service.getAll())

  ipc.handle('workbench:createTask', (_e, input) => {
    const parsed = CreateTaskInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.createTask(parsed.data)
  })

  ipc.handle('workbench:updateTask', (_e, id, patch) => {
    const parsed = UpdateTaskInputSchema.safeParse(patch)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.updateTask(id, parsed.data)
  })

  ipc.handle('workbench:completeTask', (_e, id) => service.completeTask(id))
  ipc.handle('workbench:reopenTask', (_e, id) => service.reopenTask(id))
  ipc.handle('workbench:deleteTask', (_e, id) => service.deleteTask(id))

  ipc.handle('workbench:moveTask', (_e, input) => {
    const parsed = MoveTaskInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.moveTask(parsed.data)
  })

  ipc.handle('workbench:addColumn', (_e, input) => {
    const parsed = AddColumnInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.addColumn(parsed.data.name)
  })

  ipc.handle('workbench:renameColumn', (_e, input) => {
    const parsed = RenameColumnInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid input' }
    return service.renameColumn(parsed.data.id, parsed.data.name)
  })

  ipc.handle('workbench:deleteColumn', (_e, id) => service.deleteColumn(id))
  ipc.handle('workbench:reorderColumns', (_e, orderedIds) => service.reorderColumns(orderedIds))

  log.info({ msg: 'workbench IPC wired', count: 11 })

  return {
    dispose(): void {
      unsubscribe()
      ipc.dispose()
    },
  }
}

/** Re-exported type so the IPC wiring file is the single import for callers. */
export type { WorkbenchData }
