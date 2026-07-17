// IPC handlers for the quick panel. All channels are swarm:quickPanel:*.
// focusMain: hides the panel, shows+focuses the main window, and sends a
// navigation payload over swarm:navigate (extended with a `route` field).

import { createLogger } from '@shared/logger'

import { createIpcRegistrar } from '../ipc/wire'
import { getMainWindow } from '../windows/main-window'
import { openSettings } from '../windows/open-settings'
import { hideQuickPanel } from './quick-panel-window'
import type { ShortcutManager } from './shortcut'

const log = createLogger({ process: 'main' }).child({ component: 'quick-panel-ipc' })

type FocusMainPayload = {
  navigate?: string
  settings?: string
}

export function wireQuickPanelIpc(opts: { shortcut: ShortcutManager }): { dispose: () => void } {
  const { shortcut } = opts
  const ipc = createIpcRegistrar()

  ipc.handle('swarm:quickPanel:hide', () => {
    hideQuickPanel()
  })

  ipc.handle('swarm:quickPanel:focusMain', (_e, payload: FocusMainPayload) => {
    hideQuickPanel()
    const win = getMainWindow()
    if (!win) {
      log.warn({ msg: 'focusMain: no main window' })
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()

    if (payload.navigate) {
      // Extended swarm:navigate: main-window listener handles both sessionId
      // and route fields. For palette items, navigate is a route string
      // (e.g. "/", "/formations", "/session/$sessionId").
      win.webContents.send('swarm:navigate', { route: payload.navigate })
      log.info({ msg: 'focusMain navigate', route: payload.navigate })
    }
    if (payload.settings) {
      openSettings({ initialRoute: payload.settings })
      log.info({ msg: 'focusMain openSettings', section: payload.settings })
    }
  })

  ipc.handle('swarm:quickPanel:getHotkey', () => {
    return shortcut.getCurrent() ?? ''
  })

  ipc.handle('swarm:quickPanel:setHotkey', async (_e, accelerator: string) => {
    const ok = await shortcut.reregister(accelerator)
    if (!ok) {
      log.warn({ msg: 'setHotkey rejected by OS', accelerator })
    }
    return { ok }
  })

  log.info({ msg: 'quick panel IPC wired' })

  return {
    dispose: () => {
      ipc.dispose()
    },
  }
}
