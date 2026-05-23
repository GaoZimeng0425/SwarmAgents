import { cpus } from 'node:os'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { app, BrowserWindow, ipcMain, shell } from 'electron'

import icon from '../../resources/icon.png?asset'
import { createPermissionGate } from './permission/gate'
import { createSupervisor } from './supervisor'
import { createElectronSpawner } from './supervisor/electron-spawner'

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  // ship-readiness A.2 / B.1: backgroundColor matches app theme to avoid
  // white-flash before first paint. ship D.31: use platform material on mac.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          vibrancy: 'sidebar',
          visualEffectState: 'active',
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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
  // IMPORTANT: electron-vite emits ESM (.mjs), not .js — verify the actual filename in out/main/.
  const workerEntry = join(__dirname, 'worker.mjs')

  const supervisor = createSupervisor({
    spawner: createElectronSpawner(),
    workerEntry,
    poolSize,
  })
  const permissionGate = createPermissionGate({ defaultPolicy: 'prompt-on-medium-and-high' })

  await supervisor.start()
  log.info({ msg: 'core services up', poolSize, workerEntry })

  // Stash on globalThis for renderer-IPC handlers added in later plans.
  ;(globalThis as unknown as { __swarm: unknown }).__swarm = { supervisor, permissionGate }

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

  createWindow()

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
