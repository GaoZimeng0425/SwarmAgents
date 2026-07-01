// Wires the budget config subsystem to Electron IPC: get / set handlers plus a
// broadcast of the new config to all renderer windows on change.
import { createLogger } from '@shared/logger'
import { BudgetConfigSchema } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'budgets-ipc' })

const STATE_CHANGED_CHANNEL = 'budgets:stateChanged'

export function wireBudgetsIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args

  const unsubscribe = service.onStateChanged((config) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(STATE_CHANGED_CHANNEL, config)
    }
  })

  ipcMain.handle('budgets:get', () => service.get())

  ipcMain.handle('budgets:set', (_e: Electron.IpcMainInvokeEvent, config: unknown) => {
    const parsed = BudgetConfigSchema.safeParse(config)
    if (!parsed.success)
      return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid budget config' }
    return service.set(parsed.data)
  })

  log.info({ msg: 'budgets IPC wired' })

  return {
    dispose(): void {
      unsubscribe()
      ipcMain.removeHandler('budgets:get')
      ipcMain.removeHandler('budgets:set')
    },
  }
}
