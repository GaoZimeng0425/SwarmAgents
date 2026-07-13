import { rm } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createShortcutManager } from './shortcut'
import { createQuickPanelStore, DEFAULT_HOTKEY } from './store'

// reregister persists to disk via the store, so clean the shared fixture between
// tests to keep each test loading DEFAULT_HOTKEY on init.
const storeFile = '/tmp/qp-test-nonexistent.json'

// Mock electron globalShortcut
const registerMock = vi.fn<(accel: string, cb: () => void) => boolean>()
const unregisterMock = vi.fn<(accel: string) => void>()

vi.mock('electron', () => ({
  globalShortcut: {
    register: (...args: [string, () => void]) => registerMock(...args),
    unregister: (...args: [string]) => unregisterMock(...args),
  },
}))

// Minimal silent logger
const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as any

describe('createShortcutManager', () => {
  beforeEach(async () => {
    await rm(storeFile, { force: true })
    registerMock.mockReset()
    unregisterMock.mockReset()
    registerMock.mockReturnValue(true)
  })

  it('registers the stored hotkey on init', async () => {
    const store = createQuickPanelStore({ filePath: storeFile })
    const mgr = createShortcutManager({ store, log: silentLog })
    const onToggle = vi.fn()
    await mgr.init(onToggle)

    expect(registerMock).toHaveBeenCalledWith(DEFAULT_HOTKEY, onToggle)
    expect(mgr.getCurrent()).toBe(DEFAULT_HOTKEY)
  })

  it('reregister unregisters old then registers new', async () => {
    const store = createQuickPanelStore({ filePath: storeFile })
    const mgr = createShortcutManager({ store, log: silentLog })
    await mgr.init(vi.fn())

    const ok = await mgr.reregister('CommandOrControl+Alt+P')
    expect(ok).toBe(true)
    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_HOTKEY)
    expect(registerMock).toHaveBeenCalledWith('CommandOrControl+Alt+P', expect.any(Function))
    expect(mgr.getCurrent()).toBe('CommandOrControl+Alt+P')
  })

  it('reregister returns false and keeps old on failure', async () => {
    const store = createQuickPanelStore({ filePath: storeFile })
    const mgr = createShortcutManager({ store, log: silentLog })
    await mgr.init(vi.fn())

    registerMock.mockReturnValue(false)
    const ok = await mgr.reregister('CommandOrControl+Alt+Q')
    expect(ok).toBe(false)
    // Old hotkey is NOT unregistered on failure (register returned false first)
    expect(mgr.getCurrent()).toBe(DEFAULT_HOTKEY)
  })

  it('dispose unregisters the current hotkey', async () => {
    const store = createQuickPanelStore({ filePath: storeFile })
    const mgr = createShortcutManager({ store, log: silentLog })
    await mgr.init(vi.fn())
    mgr.dispose()
    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_HOTKEY)
  })
})
