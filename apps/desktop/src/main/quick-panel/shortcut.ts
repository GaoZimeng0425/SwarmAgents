// Wraps Electron globalShortcut with config-store-backed register/unregister.
// On init: loads the stored hotkey and registers it. On reregister: tries the
// new accelerator; if it fails, the old one stays registered (no gap).
import { globalShortcut } from 'electron'

import type { QuickPanelConfig, QuickPanelStore } from './store'

export type ShortcutManager = {
  /** Load stored config and register the hotkey. Call once at app ready. */
  init(onToggle: () => void): Promise<void>
  /** Swap to a new accelerator. Persists on success. Returns false if OS rejects. */
  reregister(accelerator: string): Promise<boolean>
  /** The currently-registered accelerator (or null if none). */
  getCurrent(): string | null
  /** Unregister and clean up. Call on app quit. */
  dispose(): void
}

type Logger = { info(obj: unknown): void; warn(obj: unknown): void; error(obj: unknown): void }

export function createShortcutManager(opts: { store: QuickPanelStore; log: Logger }): ShortcutManager {
  const { store, log } = opts
  let current: string | null = null
  let toggleCb: (() => void) | null = null

  const init = async (onToggle: () => void): Promise<void> => {
    toggleCb = onToggle
    const config: QuickPanelConfig = await store.load()
    const ok = globalShortcut.register(config.hotkey, onToggle)
    if (ok) {
      current = config.hotkey
      log.info({ msg: 'quick panel hotkey registered', accelerator: config.hotkey })
    } else {
      log.error({ msg: 'quick panel hotkey register failed', accelerator: config.hotkey })
    }
  }

  const reregister = async (accelerator: string): Promise<boolean> => {
    // Try registering the new one FIRST. Only unregister the old if the new succeeds.
    const ok = globalShortcut.register(accelerator, toggleCb ?? (() => undefined))
    if (!ok) {
      log.warn({ msg: 'reregister failed, keeping old hotkey', accelerator, current })
      return false
    }
    if (current) globalShortcut.unregister(current)
    current = accelerator
    await store.save({ hotkey: accelerator })
    log.info({ msg: 'quick panel hotkey updated', accelerator })
    return true
  }

  const getCurrent = (): string | null => current

  const dispose = (): void => {
    if (current) {
      globalShortcut.unregister(current)
      current = null
    }
  }

  return { init, reregister, getCurrent, dispose }
}
