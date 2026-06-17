// Entry point for the budget-config subsystem. Wires the plaintext store, the
// in-memory service, and the Electron IPC layer. Runs after app.whenReady().
import { join } from 'node:path'
import { app } from 'electron'

import { wireBudgetsIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

export type BudgetsHandle = {
  service: Service
  dispose(): void
}

export async function initBudgets(): Promise<BudgetsHandle> {
  const store = createStore({ filePath: join(app.getPath('userData'), 'budgets.json') })
  const service = await createService({ store })
  const { dispose } = wireBudgetsIpc({ service })
  return { service, dispose }
}

export type { Service } from './service'
