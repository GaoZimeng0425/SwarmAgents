// src/main/system/auto-update.ts
//
// ship G.62: auto-update is a real silent process, not a "please download a
// new version" link. Uses electron-updater (already a dep). Checks at startup,
// then every 4h. Notifies the renderer via a single update-ready event when a
// download is staged for next launch.
import { is } from '@electron-toolkit/utils'
import { createLogger } from '@shared/logger'
import { autoUpdater } from 'electron-updater'

import { sendToAllWindows } from '../ipc/wire'

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

export function setupAutoUpdate(): void {
  if (is.dev) return
  const log = createLogger({ process: 'main' }).child({ component: 'auto-update' })
  // electron-updater expects an electron-log-shaped logger; pino isn't a drop-in.
  // For v1 we leave logger at default (console). v1.1: a small pino→electron-log adapter.
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', () => {
    log.info({ msg: 'update downloaded, will install on next launch' })
    sendToAllWindows('system:updateReady', undefined)
  })
  autoUpdater.on('error', (err) => {
    log.warn({ msg: 'auto-update error', err: String(err) })
  })
  void autoUpdater.checkForUpdates()
  setInterval(() => {
    void autoUpdater.checkForUpdates()
  }, FOUR_HOURS_MS)
}
