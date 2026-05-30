import { fork } from 'node:child_process'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'

import { wireSwarmIpc } from './ipc/swarm-ipc'
import { initProviders } from './providers'
import { createServiceClient } from './service-client'
import { setupAutoUpdate } from './system/auto-update'
import { setupMenu } from './system/menu'
import { parseDeepLinkFromArgv, registerUrlScheme } from './system/url-scheme'
import { createMainWindow } from './windows/main-window'
import { openSettings } from './windows/settings-window'

// ship-readiness G.64: single-instance on Windows / Linux. Second launch
// focuses the existing window instead of spawning a new process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('dev.swarmagents.app')

  // Tee main + worker logs to a file under userData so dev sessions persist a
  // single inspectable JSON-lines log. Workers inherit `process.env` via
  // electron-spawner, so setting it here covers both. MUST happen before any
  // createLogger() call (worker fork included).
  if (!process.env.SWARM_LOG_FILE) {
    process.env.SWARM_LOG_FILE = join(app.getPath('userData'), 'swarm-dev.log')
  }

  const log = createLogger({ process: 'main' })
  log.info({ msg: 'log file', path: process.env.SWARM_LOG_FILE })

  const providers = await initProviders()
  log.info({ msg: 'providers initialised' })

  app.on('before-quit', () => {
    providers.dispose()
  })

  const serviceEntry = join(__dirname, 'service.js')
  const serviceProcess = fork(serviceEntry, [], {
    env: {
      ...process.env,
      SWARM_SERVICE_DB_PATH: join(app.getPath('userData'), 'agent-service.db'),
    },
    silent: true,
  })

  let serviceClient: ReturnType<typeof createServiceClient>
  try {
    serviceProcess.stderr?.on('data', (c: Buffer) => log.warn({ msg: 'service stderr', data: c.toString().trim() }))

    const servicePort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('service startup timeout')), 10_000)
      serviceProcess.stdout?.on('data', (chunk: Buffer) => {
        try {
          const msg = JSON.parse(chunk.toString().trim()) as { type: string; port: number }
          if (msg.type === 'service-started') {
            clearTimeout(timeout)
            serviceProcess.stdout?.removeAllListeners('data')
            resolve(msg.port)
          }
        } catch {}
      })
      serviceProcess.on('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`service exited with code ${String(code)}`))
      })
    })

    serviceClient = createServiceClient({
      port: servicePort,
      onEvent: (_event, data) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('swarm:event', data)
        }
      },
    })
    await serviceClient.connect()

    wireSwarmIpc({ serviceClient, providers: providers.service })
    log.info({ msg: 'core services up', servicePort })
  } catch (err) {
    log.error({ msg: 'Agent Service failed to start', err: String(err) })
    serviceProcess.kill('SIGTERM')
    dialog.showErrorBox('Agent Service failed', String(err))
    app.quit()
    return
  }

  const handleDeepLink = (url: string): void => {
    log.info({ msg: 'deep link received', url })
    // v1: just log. Routing is a v1.1 extension (e.g., swarmagents://task/<id>).
  }
  registerUrlScheme('swarmagents', handleDeepLink)
  setupAutoUpdate()

  setupMenu({ onOpenSettings: openSettings })

  app.on('second-instance', (_e, argv) => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
    const deepLink = parseDeepLinkFromArgv(argv, 'swarmagents')
    if (deepLink) handleDeepLink(deepLink)
  })

  app.on('before-quit', () => {
    serviceClient.disconnect()
    serviceProcess.kill('SIGTERM')
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
