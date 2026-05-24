import { cpus } from 'node:os'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { app, BrowserWindow, ipcMain } from 'electron'

import { wireSwarmIpc } from './ipc/swarm-ipc'
import { createPermissionGate } from './permission/gate'
import { createSupervisor } from './supervisor'
import { createElectronSpawner } from './supervisor/electron-spawner'
import { createMainWindow } from './windows/main-window'

// ship-readiness G.64: single-instance on Windows / Linux. Second launch
// focuses the existing window instead of spawning a new process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })
}

app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  const log = createLogger({ process: 'main' })
  const poolSize = Math.min(cpus().length, 4)
  const workerEntry = join(__dirname, 'worker.js')

  const supervisor = createSupervisor({
    spawner: createElectronSpawner(),
    workerEntry,
    poolSize,
  })
  const permissionGate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })

  await supervisor.start()
  wireSwarmIpc({ supervisor, permissionGate })
  log.info({ msg: 'core services up', poolSize, workerEntry })

  app.on('before-quit', async () => {
    await supervisor.shutdown()
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createMainWindow()

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
