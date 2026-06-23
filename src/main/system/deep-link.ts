// src/main/system/deep-link.ts
//
// Routes incoming swarmagents:// deep links:
//   swarmagents://settings[/<route>] → opens the Settings window.
//   swarmagents://chat/<sessionId>   → navigates the main window to that session.
// A chat link can arrive before the renderer has subscribed (cold start, where
// the URL fires during app startup, before the window loads). Such links are
// buffered and pulled by the renderer on mount via consumePendingDeepLink;
// links that arrive while the app is running are pushed over NAVIGATE_CHANNEL.
import { createLogger } from '@shared/logger'
import { ipcMain } from 'electron'

import { getMainWindow } from '../windows/main-window'
import { openSettings } from '../windows/open-settings'

const log = createLogger({ process: 'main' }).child({ component: 'deep-link' })

const NAVIGATE_CHANNEL = 'swarm:navigate'

// A chat deep link that arrived before the renderer could receive a push.
// Held until the renderer pulls it on mount.
let pendingSessionId: string | null = null

function navigateToSession(sessionId: string): void {
  const win = getMainWindow()
  if (win && !win.webContents.isLoading()) {
    win.webContents.send(NAVIGATE_CHANNEL, { sessionId })
    if (win.isMinimized()) win.restore()
    win.focus()
    log.info({ msg: 'deep link → navigate session (push)', sessionId })
  } else {
    // No window yet, or still loading: stash for the renderer to pull on mount.
    pendingSessionId = sessionId
    log.info({ msg: 'deep link → navigate session (buffered)', sessionId })
  }
}

export function handleDeepLink(url: string): void {
  log.info({ msg: 'deep link received', url })
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    log.warn({ msg: 'deep link is not a valid URL', url })
    return
  }
  // swarmagents://settings or swarmagents://settings/<route>
  if (parsed.host === 'settings') {
    const route = parsed.pathname.replace(/^\//, '') || undefined
    log.info({ msg: 'deep link → open settings', route })
    openSettings(route ? { initialRoute: route } : {})
    return
  }
  // swarmagents://chat/<sessionId>
  if (parsed.host === 'chat') {
    const sessionId = parsed.pathname.replace(/^\//, '')
    if (!sessionId) {
      log.warn({ msg: 'chat deep link missing session id', url })
      return
    }
    navigateToSession(sessionId)
    return
  }
  log.warn({ msg: 'deep link host has no route', host: parsed.host })
}

// One-shot pull for cold-start chat links. Call once at startup.
export function registerDeepLinkIpc(): void {
  ipcMain.handle('swarm:consumePendingDeepLink', () => {
    const sessionId = pendingSessionId
    pendingSessionId = null
    return sessionId ? { sessionId } : null
  })
}
