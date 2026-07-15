import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { createServiceClient, type ServiceTransport } from '@swarm/protocol'
import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'

import { initBilibili } from './bilibili'
import { createAnalysisStore } from './bilibili/analysis-store'
import { initBudgets } from './budgets'
import { initCalendar } from './calendar'
import { initCmdPaletteArtifacts, toBilibiliArtifacts } from './cmd-palette'
import { ensureSwarmDirs, paths, servicePathEnv } from './constants'
import { initGmail } from './gmail'
import { startWsHost } from './host'
import { wireArticleIpc } from './ipc/article-ipc'
import { toRendererEvent } from './ipc/forward-event'
import { wireSwarmIpc } from './ipc/swarm-ipc'
import { initMcpServers } from './mcp-servers'
import { initProviders } from './providers'
import { initQuickPanel } from './quick-panel'
import { setupAutoUpdate } from './system/auto-update'
import { handleDeepLink, registerDeepLinkIpc } from './system/deep-link'
import { setupMenu } from './system/menu'
import { parseDeepLinkFromArgv, registerUrlScheme } from './system/url-scheme'
import { initTrending } from './trending'
import { wireTrendingResearchIpc } from './trending/ipc'
import { initWeather } from './weather'
import { initWebSearch } from './web-search'
import { createMainWindow, getMainWindow } from './windows/main-window'
import { openSettings } from './windows/open-settings'
import { initWorkbench } from './workbench'

// productName in electron-builder.yml only renames packaged builds; in dev
// app.name falls back to "Electron". Set it explicitly so the macOS app menu
// label is correct everywhere.
app.setName('SwarmAgents')

// ship-readiness G.64: single-instance on Windows / Linux. Second launch
// focuses the existing window instead of spawning a new process.
// E2E runs launch a second instance alongside the user's app; skip the lock
// only when the e2e harness explicitly opts in. Production is unaffected.
if (!process.env.SWARM_E2E && !app.requestSingleInstanceLock()) {
  app.quit()
}

app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('dev.swarmagents.app')

  // Tee main + worker logs to a file under ~/.swarm-agents so dev sessions
  // persist a single inspectable JSON-lines log. Workers inherit `process.env` via
  // electron-spawner, so setting it here covers both. MUST happen before any
  // createLogger() call (worker fork included).
  if (!process.env.SWARM_LOG_FILE) {
    process.env.SWARM_LOG_FILE = paths.log()
  }

  const log = createLogger({ process: 'main' })
  log.info({ msg: 'log file', path: process.env.SWARM_LOG_FILE })

  // Create skills/ and agents/ up front so ~/.swarm-agents is a discoverable
  // drop-in home even on a fresh install (stores otherwise only mkdir on save).
  ensureSwarmDirs()

  const providers = await initProviders()
  log.info({ msg: 'providers initialised' })

  const mcpServers = await initMcpServers()
  log.info({ msg: 'mcp servers initialised' })

  const webSearch = await initWebSearch()
  log.info({ msg: 'web search config initialised' })

  const budgets = await initBudgets()
  log.info({ msg: 'budget config initialised' })

  const workbench = await initWorkbench()
  log.info({ msg: 'workbench initialised' })

  const trending = initTrending()
  log.info({ msg: 'trending IPC initialised' })

  const bilibili = initBilibili({
    getInjection: () => providers.service.getInjection(),
    // Delayed binding: serviceClient is assigned after the service process is
    // ready (below), but a user never triggers analysis before that.
    analyzeBilibili: (req) => serviceClient.analyzeBilibili(req),
  })
  log.info({ msg: 'bilibili IPC initialised' })

  const gmail = await initGmail()
  log.info({ msg: 'gmail sidecar initialised' })

  const calendar = await initCalendar()
  log.info({ msg: 'calendar sidecar initialised' })

  const weather = await initWeather()
  log.info({ msg: 'weather initialised' })

  app.on('before-quit', () => {
    providers.dispose()
    mcpServers.dispose()
    webSearch.dispose()
    budgets.dispose()
    trending.dispose()
    bilibili.dispose()
    gmail.dispose()
    calendar.dispose()
    weather.dispose()
    workbench.dispose()
  })

  const serviceEntry = join(__dirname, 'service.js')
  const serviceProcess = utilityProcess.fork(serviceEntry, [], {
    stdio: ['ignore', 'inherit', 'pipe'],
    env: {
      ...process.env,
      ...Object.fromEntries(servicePathEnv.map(([name, getter]) => [name, getter()])),
    },
  })

  let serviceClient: ReturnType<typeof createServiceClient>
  let wsHost: { port: number; token: string; lanIp: string | null; dispose: () => void } | null = null
  try {
    serviceProcess.stderr?.on('data', (c: Buffer) => log.warn({ msg: 'service stderr', data: c.toString().trim() }))

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('service startup timeout')), 10_000)
      const onReady = (message: unknown): void => {
        if ((message as { kind?: string })?.kind === 'ready') {
          clearTimeout(timeout)
          serviceProcess.off('message', onReady)
          resolve()
        }
      }
      serviceProcess.on('message', onReady)
      serviceProcess.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`service exited with code ${String(code)}`))
      })
    })

    serviceClient = createServiceClient({
      transport: serviceProcess as unknown as ServiceTransport,
      onEvent: (event, data) => {
        // MCP status rides a dedicated channel — it isn't a task UIEvent and
        // must not reach applyEvent (which would create a phantom task stub).
        const channel = event.startsWith('mcp.') ? 'mcp:status' : 'swarm:event'
        const payload = channel === 'mcp:status' ? data : toRendererEvent(event, data)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send(channel, payload)
        }
      },
    })
    await serviceClient.connect()
    // External clients (extension/RN) bridge to the service over a loopback WS.
    wsHost = await startWsHost({ serviceProcess, userDataDir: app.getPath('userData'), log })
    log.info({ msg: 'ws-host up', port: wsHost.port })
    gmail.registerRpcHandlers(serviceClient)
    calendar.registerRpcHandlers(serviceClient)
    weather.registerRpcHandlers(serviceClient)
    bilibili.registerRpcHandlers(serviceClient)

    // Command palette artifacts: join bilibili analyses.
    // The analysis store is re-created from the same on-disk file the bilibili
    // subsystem writes to (read-only here; bilibili owns writes). Video titles
    // aren't stored on the analysis, so they fall back to the bvid.
    const analysisStore = createAnalysisStore({ filePath: paths.bilibiliAnalysis() })
    const cmdPalette = initCmdPaletteArtifacts({
      bilibiliSource: async () => toBilibiliArtifacts(analysisStore.bvids().map((bvid) => ({ bvid }))),
    })

    wireSwarmIpc({
      serviceClient,
      providers: providers.service,
      mcpServers: mcpServers.service,
      webSearch: webSearch.service,
      budgets: budgets.service,
      cmdPalette,
    })
    wireArticleIpc({ serviceClient, providers: providers.service })
    wireTrendingResearchIpc({ serviceClient, providers: providers.service })
    // Surface the WS host config (port + token + LAN IP) to the renderer so
    // Settings → 远程连接 can display the token and a QR for the phone. wsHost
    // is assigned at line 150 once the server is up; null before that.
    ipcMain.handle('system:getWsHostConfig', () =>
      wsHost ? { port: wsHost.port, token: wsHost.token, lanIp: wsHost.lanIp } : null
    )
    log.info({ msg: 'core services up' })
  } catch (err) {
    log.error({ msg: 'Agent Service failed to start', err: String(err) })
    serviceProcess.kill()
    dialog.showErrorBox('Agent Service failed', String(err))
    app.quit()
    return
  }

  registerDeepLinkIpc()
  registerUrlScheme('swarmagents', handleDeepLink)
  // Capture argv now so it's available after createMainWindow(), but defer
  // handleDeepLink until the window exists (openSettings needs getMainWindow()).
  const initialDeepLink = parseDeepLinkFromArgv(process.argv, 'swarmagents')
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
    quickPanel.dispose()
    wsHost?.dispose()
    serviceClient.disconnect()
    serviceProcess.kill()
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
  const quickPanel = initQuickPanel()
  // Cold start on Windows/Linux: the URL arrives in the first instance's argv
  // (macOS cold start routes via the `open-url` event registered above).
  // MUST run after createMainWindow() so getMainWindow() is non-null; the
  // window's webContents may still be loading at this point but both handlers
  // are safe: openSettings schedules did-finish-load, and navigateToSession
  // buffers via pendingSessionId if isLoading() is true.
  if (initialDeepLink) handleDeepLink(initialDeepLink)

  app.on('activate', () => {
    // On macOS, clicking the dock icon should show/focus the main window — or
    // recreate it if it was closed. Counting all windows breaks here: the
    // quick-panel is a long-lived hidden window that is never destroyed, so
    // getAllWindows().length is always ≥ 1 even after the main window closes,
    // leaving the dock icon unable to reopen the app. Check the main window
    // specifically: show+focus if it exists, recreate if not.
    const main = getMainWindow()
    if (main) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    } else {
      createMainWindow()
    }
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
