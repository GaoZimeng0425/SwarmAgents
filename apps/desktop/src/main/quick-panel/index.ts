// Orchestrator: creates the panel window, initializes the shortcut manager,
// and wires the IPC handlers. Returns a dispose() for app shutdown.

import { createLogger } from '@shared/logger'

import { paths } from '../constants'
import { wireQuickPanelIpc } from './ipc'
import { createQuickPanelWindow, toggleQuickPanel } from './quick-panel-window'
import { createShortcutManager } from './shortcut'
import { createQuickPanelStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'quick-panel' })

export function initQuickPanel(): { dispose: () => void } {
  // Create the window up front (hidden) so the first toggle is instant.
  createQuickPanelWindow()

  const store = createQuickPanelStore({ filePath: paths.quickPanel() })
  const shortcut = createShortcutManager({ store, log })

  // Register the hotkey → toggle the panel.
  void shortcut.init(() => toggleQuickPanel())

  wireQuickPanelIpc({ shortcut })

  log.info({ msg: 'quick panel initialized' })

  return {
    dispose: () => {
      shortcut.dispose()
      log.info({ msg: 'quick panel disposed' })
    },
  }
}
