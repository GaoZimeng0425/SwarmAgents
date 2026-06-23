// src/main/windows/open-settings.ts
//
// In-app Settings navigation. Replaces the old standalone Settings BrowserWindow:
// menu / deep-link entry points focus the main window and push a route over
// SETTINGS_NAV_CHANNEL; the renderer (useEventsSubscription) performs the
// router navigation.
import { createLogger } from '@shared/logger'

import { getMainWindow } from './main-window'

const log = createLogger({ process: 'main' }).child({ component: 'open-settings' })

// Keep in sync with preload's SETTINGS_NAV_CHANNEL.
const SETTINGS_NAV_CHANNEL = 'swarm:navigate-settings'

export function openSettings(opts: { initialRoute?: string } = {}): void {
  const route = opts.initialRoute ? `/settings/${opts.initialRoute.replace(/^\//, '')}` : '/settings'
  log.info({ msg: 'open settings requested', route })
  const win = getMainWindow()
  if (!win) {
    log.warn({ msg: 'open settings: no main window', route })
    return
  }
  try {
    const send = (): void => win.webContents.send(SETTINGS_NAV_CHANNEL, { route })
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', send)
      log.info({ msg: 'navigate settings (queued)', route })
    } else {
      send()
      log.info({ msg: 'navigate settings (sent)', route })
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } catch (err) {
    log.error({ msg: 'open settings failed', err: err instanceof Error ? err.message : String(err), route })
  }
}
