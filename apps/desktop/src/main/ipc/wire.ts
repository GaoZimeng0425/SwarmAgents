// Typed bindings between the renderer-IPC signature tables and Electron's
// untyped ipcMain/webContents surfaces. One registrar per wiring unit: it
// remembers what it registered so dispose() removes exactly that set — the
// hand-maintained removeHandler lists this replaces drifted from the handle
// lists more than once.
import type {
  RendererIpcChannel,
  RendererIpcEventChannel,
  RendererIpcEvents,
  RendererIpcSignatures,
} from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

export type TypedIpcHandler<C extends RendererIpcChannel> = (
  e: Electron.IpcMainInvokeEvent,
  ...args: RendererIpcSignatures[C]['args']
) => RendererIpcSignatures[C]['result'] | Promise<RendererIpcSignatures[C]['result']>

export function createIpcRegistrar(): {
  handle<C extends RendererIpcChannel>(channel: C, fn: TypedIpcHandler<C>): void
  dispose(): void
} {
  const registered: RendererIpcChannel[] = []
  return {
    handle(channel, fn) {
      // Single documented cast: Electron's handler type is untyped; the table
      // typing above is the real contract (mirrors the service dispatcher's
      // choke-point cast).
      ipcMain.handle(channel, fn as (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown)
      registered.push(channel)
    },
    dispose() {
      for (const channel of registered.splice(0)) ipcMain.removeHandler(channel)
    },
  }
}

export function sendToAllWindows<C extends RendererIpcEventChannel>(channel: C, payload: RendererIpcEvents[C]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}
