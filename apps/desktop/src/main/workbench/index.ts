// Entry point for the workbench subsystem. Wires the plaintext store, the
// in-memory service, and the Electron IPC layer. Runs after app.whenReady().
import { paths } from '../constants'
import { wireWorkbenchIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

export type WorkbenchHandle = {
  service: Service
  dispose(): void
}

export async function initWorkbench(): Promise<WorkbenchHandle> {
  const store = createStore({ filePath: paths.workbench() })
  const service = await createService({ store })
  const { dispose } = wireWorkbenchIpc({ service })
  return { service, dispose }
}

export type { Service } from './service'
