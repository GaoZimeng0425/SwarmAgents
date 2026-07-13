# Quick Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global-hotkey floating panel (Spotlight/Raycast-style) that quick-launches palette commands and runs mini agent conversations, persisting results to the session list.

**Architecture:** A new frameless `BrowserWindow` created by the main process, triggered by a configurable `globalShortcut`. It loads the same renderer bundle at hash route `#/quick-panel`. The renderer reuses the existing palette's `buildItems` + `usePaletteData` for quick-launch, and runs agent chats via the existing `swarm.submitPrompt` IPC. Event broadcast already iterates `BrowserWindow.getAllWindows()`, so the panel auto-receives `swarm:event` streaming.

**Tech Stack:** Electron (`globalShortcut`, `BrowserWindow`, `screen`), React + TanStack Router, zustand, pino logging, vitest.

## Global Constraints

- **Language:** Code comments and commit messages in English. Conversational replies in Chinese (AGENTS.md §0).
- **Logging:** Every business path gets structured pino logs — `createLogger({ process: 'main' }).child({ component: 'quick-panel-*' })`. Entry points at `info`, catches at `error`, surprises at `warn` (AGENTS.md §5).
- **Package manager:** pnpm. Dev command: `pnpm --filter @swarm/desktop dev`.
- **Test command:** `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run` (from `apps/desktop`).
- **Build:** electron-vite + electron-builder. Config in `apps/desktop/electron.vite.config.ts`.
- **IPC naming:** `swarm:quickPanel:*` namespace, colon-separated, matching existing convention.
- **Surgical changes:** Touch only what the task requires. Match existing code style (AGENTS.md §3).
- **Config store style:** Plaintext JSON in `userData/`, atomic write (tmp → rename), same pattern as `web-search/store.ts`.

---

## File Structure

### New files — main process

```
apps/desktop/src/main/quick-panel/
  store.ts                  # quick-panel.json read/write (hotkey config)
  store.test.ts
  shortcut.ts               # registerQuickPanelHotkey / unregisterQuickPanelHotkey
  shortcut.test.ts
  quick-panel-window.ts     # createQuickPanelWindow / getQuickPanelWindow / toggle / show / hide
  ipc.ts                    # wireQuickPanelIpc: hide / resize / focusMain / getHotkey / setHotkey
  index.ts                  # initQuickPanel(): wire everything, called from main/index.ts
```

### New files — renderer

```
apps/desktop/src/renderer/src/routes/
  quick-panel.tsx           # /quick-panel route component

apps/desktop/src/renderer/src/components/quick-panel/
  quick-panel.tsx           # top-level: mode switching (palette | chat)
  quick-panel-input.tsx     # input + slash command popover
  quick-panel-results.tsx   # palette results list (reuses PaletteResults rendering)
  quick-panel-chat.tsx      # chat mini-session
  use-quick-panel-state.ts  # state machine: query / mode / sessionId / slash handling
```

### New files — settings

```
apps/desktop/src/renderer/src/components/views/quick-panel-settings-view.tsx  # settings section
```

### Modified files

| File | Change |
|------|--------|
| `main/constants.ts` | Add `quickPanel: () => join(app.getPath('userData'), 'quick-panel.json')` to `paths` |
| `main/index.ts` | Call `initQuickPanel()` after `createMainWindow()`; unregister on `before-quit` |
| `main/windows/open-settings.ts` | No change needed (reused as-is) |
| `preload/index.ts` | Add `quickPanel` bridge + extend `onNavigateToSession` payload |
| `preload/index.d.ts` | Add `quickPanel` type + update `onNavigateToSession` signature |
| `renderer/src/routes/__root.tsx` | Skip TitleBar/AppRail when route is `/quick-panel` |
| `renderer/src/hooks/use-events-subscription.ts` | Handle `route` field in `onNavigateToSession` callback |
| `renderer/src/lib/api.ts` | Update `onNavigateToSession` wrapper signature |
| `renderer/src/stores/settings-dialog.ts` | Add `quick-panel` section to `SettingsSection` + `SECTIONS_REGISTRY` |

---

## Task 1: Config Store

Store for the quick-panel hotkey configuration. Plaintext JSON at `userData/quick-panel.json`, atomic writes, same pattern as `web-search/store.ts`.

**Files:**
- Create: `apps/desktop/src/main/quick-panel/store.ts`
- Test: `apps/desktop/src/main/quick-panel/store.test.ts`
- Modify: `apps/desktop/src/main/constants.ts` (add `quickPanel` path)

**Interfaces:**
- Produces: `createQuickPanelStore(opts: { filePath: string }): QuickPanelStore` where `QuickPanelStore = { load(): Promise<QuickPanelConfig>; save(config: QuickPanelConfig): Promise<void> }` and `QuickPanelConfig = { hotkey: string }`. Default hotkey: `'CommandOrControl+Shift+Space'`.

- [ ] **Step 1: Add the path constant**

Modify `apps/desktop/src/main/constants.ts` — add to the `paths` object (after `workbench`):

```ts
  // Quick panel hotkey config (plaintext JSON, user-editable via Settings).
  quickPanel: () => join(app.getPath('userData'), 'quick-panel.json'),
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/quick-panel/store.test.ts`:

```ts
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach } from 'vitest'

import { createQuickPanelStore, DEFAULT_HOTKEY } from './store'

const tmpFile = join(tmpdir(), `qp-store-${process.pid}-${Date.now()}.json`)

describe('createQuickPanelStore', () => {
  beforeEach(async () => {
    await rm(tmpFile, { force: true })
  })

  it('returns default hotkey when file is missing', async () => {
    const store = createQuickPanelStore({ filePath: tmpFile })
    const config = await store.load()
    expect(config.hotkey).toBe(DEFAULT_HOTKEY)
  })

  it('round-trips a saved config', async () => {
    const store = createQuickPanelStore({ filePath: tmpFile })
    await store.save({ hotkey: 'CommandOrControl+Alt+P' })
    const loaded = await store.load()
    expect(loaded.hotkey).toBe('CommandOrControl+Alt+P')
  })

  it('returns default on corrupt JSON', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(tmpFile, '{ not valid json')
    const store = createQuickPanelStore({ filePath: tmpFile })
    const config = await store.load()
    expect(config.hotkey).toBe(DEFAULT_HOTKEY)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `apps/desktop`):
```bash
cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/quick-panel/store.test.ts
```
Expected: FAIL — module `./store` not found.

- [ ] **Step 4: Write minimal implementation**

Create `apps/desktop/src/main/quick-panel/store.ts`:

```ts
// Plaintext on-disk quick-panel config store. Reads/writes a single JSON file.
// Same pattern as web-search/store.ts: atomic write (tmp → rename), forgiving
// load (returns defaults on missing/corrupt file).
import { existsSync, promises as fs } from 'node:fs'

export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space'

export type QuickPanelConfig = {
  hotkey: string
}

export type QuickPanelStore = {
  load(): Promise<QuickPanelConfig>
  save(config: QuickPanelConfig): Promise<void>
}

function defaultConfig(): QuickPanelConfig {
  return { hotkey: DEFAULT_HOTKEY }
}

export function createQuickPanelStore(opts: { filePath: string }): QuickPanelStore {
  const { filePath } = opts

  const load = async (): Promise<QuickPanelConfig> => {
    if (!existsSync(filePath)) return defaultConfig()
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      if (typeof parsed?.hotkey === 'string') return { hotkey: parsed.hotkey }
      return defaultConfig()
    } catch {
      return defaultConfig()
    }
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()

  const save = (config: QuickPanelConfig): Promise<void> => {
    const next = saveQueue.then(async () => {
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, save }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/quick-panel/store.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/quick-panel/store.ts apps/desktop/src/main/quick-panel/store.test.ts apps/desktop/src/main/constants.ts
git commit -m "feat(quick-panel): add config store for hotkey persistence"
```

---

## Task 2: Global Shortcut Registration

Wraps Electron's `globalShortcut` with register/unregister + config store integration. Pure logic (no window creation here — that's Task 3).

**Files:**
- Create: `apps/desktop/src/main/quick-panel/shortcut.ts`
- Test: `apps/desktop/src/main/quick-panel/shortcut.test.ts`

**Interfaces:**
- Consumes: `QuickPanelStore` from Task 1, Electron's `globalShortcut` module.
- Produces: `createShortcutManager(opts: { store: QuickPanelStore; log: pino.Logger }): ShortcutManager` where `ShortcutManager = { init(onToggle: () => void): Promise<void>; reregister(accelerator: string): Promise<boolean>; getCurrent(): string; dispose(): void }`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/quick-panel/shortcut.test.ts`:

```ts
import { vi, describe, it, expect, beforeEach } from 'vitest'

import { createQuickPanelStore, DEFAULT_HOTKEY } from './store'
import { createShortcutManager } from './shortcut'

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
  beforeEach(() => {
    registerMock.mockReset()
    unregisterMock.mockReset()
    registerMock.mockReturnValue(true)
  })

  it('registers the stored hotkey on init', async () => {
    const store = createQuickPanelStore({ filePath: '/tmp/qp-test-nonexistent.json' })
    const mgr = createShortcutManager({ store, log: silentLog })
    const onToggle = vi.fn()
    await mgr.init(onToggle)

    expect(registerMock).toHaveBeenCalledWith(DEFAULT_HOTKEY, onToggle)
    expect(mgr.getCurrent()).toBe(DEFAULT_HOTKEY)
  })

  it('reregister unregisters old then registers new', async () => {
    const store = createQuickPanelStore({ filePath: '/tmp/qp-test-nonexistent.json' })
    const mgr = createShortcutManager({ store, log: silentLog })
    await mgr.init(vi.fn())

    const ok = await mgr.reregister('CommandOrControl+Alt+P')
    expect(ok).toBe(true)
    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_HOTKEY)
    expect(registerMock).toHaveBeenCalledWith('CommandOrControl+Alt+P', expect.any(Function))
    expect(mgr.getCurrent()).toBe('CommandOrControl+Alt+P')
  })

  it('reregister returns false and keeps old on failure', async () => {
    const store = createQuickPanelStore({ filePath: '/tmp/qp-test-nonexistent.json' })
    const mgr = createShortcutManager({ store, log: silentLog })
    await mgr.init(vi.fn())

    registerMock.mockReturnValue(false)
    const ok = await mgr.reregister('CommandOrControl+Alt+Q')
    expect(ok).toBe(false)
    // Old hotkey is NOT unregistered on failure (register returned false first)
    expect(mgr.getCurrent()).toBe(DEFAULT_HOTKEY)
  })

  it('dispose unregisters the current hotkey', async () => {
    const store = createQuickPanelStore({ filePath: '/tmp/qp-test-nonexistent.json' })
    const mgr = createShortcutManager({ store, log: silentLog })
    await mgr.init(vi.fn())
    mgr.dispose()
    expect(unregisterMock).toHaveBeenCalledWith(DEFAULT_HOTKEY)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/quick-panel/shortcut.test.ts
```
Expected: FAIL — module `./shortcut` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/quick-panel/shortcut.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/quick-panel/shortcut.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/quick-panel/shortcut.ts apps/desktop/src/main/quick-panel/shortcut.test.ts
git commit -m "feat(quick-panel): add global shortcut registration manager"
```

---

## Task 3: Floating Window

The frameless `BrowserWindow` for the quick panel. Created at app ready, hidden by default, shown/toggled on hotkey. Centers on the cursor's display.

**Files:**
- Create: `apps/desktop/src/main/quick-panel/quick-panel-window.ts`

**Interfaces:**
- Consumes: `is` from `@electron-toolkit/utils` (for dev/prod detection).
- Produces: `createQuickPanelWindow(): BrowserWindow`, `getQuickPanelWindow(): BrowserWindow | null`, `toggleQuickPanel(): void`, `showQuickPanel(): void`, `hideQuickPanel(): void`.

- [ ] **Step 1: Write minimal implementation**

Create `apps/desktop/src/main/quick-panel/quick-panel-window.ts`:

```ts
// The floating quick-panel BrowserWindow: frameless, always-on-top, skip
// taskbar, blur-to-hide. Created once at app ready (show:false) and reused —
// toggle()/show()/hide() never destroy it. show() recenters on the cursor's
// display so the panel follows the user across multi-monitor setups.
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { BrowserWindow, screen } from 'electron'

import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'main' }).child({ component: 'quick-panel-window' })

const isMac = process.platform === 'darwin'

let panelRef: BrowserWindow | null = null

const PANEL_WIDTH = 640
const PANEL_HEIGHT_INITIAL = 96

export function createQuickPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT_INITIAL,
    frame: false,
    show: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: isMac ? '#00000000' : '#1b1b1f',
    transparent: isMac,
    ...(isMac ? { vibrancy: 'menu' as const, visualEffectState: 'active' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })

  // Blur-to-hide: clicking outside the panel hides it. Running agent tasks
  // continue in the service process — hiding the window doesn't stop them.
  win.on('blur', () => {
    if (!win.isDestroyed()) {
      hideQuickPanel()
      log.debug({ msg: 'panel hidden on blur' })
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/quick-panel`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'quick-panel' })
  }

  panelRef = win
  log.info({ msg: 'quick panel window created' })
  return win
}

export function getQuickPanelWindow(): BrowserWindow | null {
  return panelRef && !panelRef.isDestroyed() ? panelRef : null
}

/** Center the panel on the display nearest the mouse cursor. */
function recenter(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const [w, h] = win.getSize()
  const x = Math.round(display.bounds.x + (display.bounds.width - w) / 2)
  const y = Math.round(display.bounds.y + (display.bounds.height - h) / 2)
  win.setPosition(x, y, false)
}

export function showQuickPanel(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  recenter()
  // Reset to initial height each time it's shown (chat mode may have grown it).
  win.setSize(PANEL_WIDTH, PANEL_HEIGHT_INITIAL)
  win.show()
  win.focus()
  log.info({ msg: 'panel shown' })
}

export function hideQuickPanel(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  win.hide()
  log.info({ msg: 'panel hidden' })
}

export function toggleQuickPanel(): void {
  const win = getQuickPanelWindow()
  if (!win) return
  if (win.isVisible() && win.isFocused()) {
    hideQuickPanel()
  } else {
    showQuickPanel()
  }
}

/** Called by the resize IPC to grow/shrink the panel to fit content. */
export function resizeQuickPanel(height: number): void {
  const win = getQuickPanelWindow()
  if (!win) return
  const clamped = Math.max(PANEL_HEIGHT_INITIAL, Math.min(height, 480))
  const [w] = win.getSize()
  win.setSize(w, clamped, false)
  log.debug({ msg: 'panel resized', height: clamped })
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/quick-panel/quick-panel-window.ts
git commit -m "feat(quick-panel): add frameless floating window factory"
```

---

## Task 4: IPC Handlers

Wires the `swarm:quickPanel:*` IPC channels. `focusMain` closes the panel and navigates the main window (reusing the extended `swarm:navigate` channel).

**Files:**
- Create: `apps/desktop/src/main/quick-panel/ipc.ts`

**Interfaces:**
- Consumes: `getQuickPanelWindow`, `hideQuickPanel`, `resizeQuickPanel` from Task 3; `getMainWindow` from `windows/main-window`; `openSettings` from `windows/open-settings`; `ShortcutManager` from Task 2.
- Produces: `wireQuickPanelIpc(opts: { shortcut: ShortcutManager }): void` — registers handlers on `ipcMain`.

- [ ] **Step 1: Write minimal implementation**

Create `apps/desktop/src/main/quick-panel/ipc.ts`:

```ts
// IPC handlers for the quick panel. All channels are swarm:quickPanel:*.
// focusMain: hides the panel, shows+focuses the main window, and sends a
// navigation payload over swarm:navigate (extended with a `route` field).
import { ipcMain } from 'electron'

import { createLogger } from '@shared/logger'
import { getMainWindow } from '../windows/main-window'
import { openSettings } from '../windows/open-settings'
import { hideQuickPanel, resizeQuickPanel } from './quick-panel-window'
import type { ShortcutManager } from './shortcut'

const log = createLogger({ process: 'main' }).child({ component: 'quick-panel-ipc' })

type FocusMainPayload = {
  navigate?: string
  settings?: string
}

export function wireQuickPanelIpc(opts: { shortcut: ShortcutManager }): void {
  const { shortcut } = opts

  ipcMain.handle('swarm:quickPanel:hide', () => {
    hideQuickPanel()
  })

  ipcMain.handle('swarm:quickPanel:resize', (_e, height: number) => {
    resizeQuickPanel(height)
  })

  ipcMain.handle('swarm:quickPanel:focusMain', (_e, payload: FocusMainPayload) => {
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

  ipcMain.handle('swarm:quickPanel:getHotkey', () => {
    return shortcut.getCurrent() ?? ''
  })

  ipcMain.handle('swarm:quickPanel:setHotkey', async (_e, accelerator: string) => {
    const ok = await shortcut.reregister(accelerator)
    if (!ok) {
      log.warn({ msg: 'setHotkey rejected by OS', accelerator })
    }
    return { ok }
  })

  log.info({ msg: 'quick panel IPC wired' })
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/quick-panel/ipc.ts
git commit -m "feat(quick-panel): wire IPC handlers for hide/resize/focusMain/hotkey"
```

---

## Task 5: Preload Bridge + navigate Extension

Extends the preload `swarm` object with the `quickPanel` bridge and extends `onNavigateToSession` to carry an optional `route` field.

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`

**Interfaces:**
- Produces (preload): `window.swarm.quickPanel` with `hide`, `resize`, `focusMain`, `getHotkey`, `setHotkey`.
- Produces (preload): `window.swarm.onNavigateToSession` callback type changes from `(sessionId: string) => void` to `(payload: { sessionId?: string; route?: string }) => void`.

- [ ] **Step 1: Add the quickPanel bridge to preload**

In `apps/desktop/src/preload/index.ts`, add the `quickPanel` bridge object to the `swarm` object that is exposed via `contextBridge`. Find the `swarm` object definition (the one passed to `exposeInMainWorld`) and add:

```ts
  quickPanel: {
    hide: () => ipcRenderer.invoke('swarm:quickPanel:hide'),
    resize: (height: number) => ipcRenderer.invoke('swarm:quickPanel:resize', height),
    focusMain: (payload: { navigate?: string; settings?: string }) =>
      ipcRenderer.invoke('swarm:quickPanel:focusMain', payload),
    getHotkey: () => ipcRenderer.invoke('swarm:quickPanel:getHotkey') as Promise<string>,
    setHotkey: (accelerator: string) =>
      ipcRenderer.invoke('swarm:quickPanel:setHotkey', accelerator) as Promise<{ ok: boolean }>,
  },
```

- [ ] **Step 2: Extend onNavigateToSession to pass full payload**

In `apps/desktop/src/preload/index.ts`, the existing `onNavigateToSession` unpacks `payload.sessionId` before calling the callback. Change it to pass the full payload so the renderer can handle both `sessionId` and `route`:

Find this block (around line 437):
```ts
  onNavigateToSession: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { sessionId: string }): void => cb(payload.sessionId)
    ipcRenderer.on(NAVIGATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(NAVIGATE_CHANNEL, listener)
    }
  },
```

Replace with:
```ts
  onNavigateToSession: (cb) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      payload: { sessionId?: string; route?: string }
    ): void => cb(payload)
    ipcRenderer.on(NAVIGATE_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(NAVIGATE_CHANNEL, listener)
    }
  },
```

- [ ] **Step 3: Update the preload type declarations**

In `apps/desktop/src/preload/index.d.ts`, update the `onNavigateToSession` type and add the `quickPanel` type. Find the existing `onNavigateToSession` type declaration and change its callback signature. Add the `quickPanel` bridge type alongside the other bridges.

The `onNavigateToSession` type changes from:
```ts
onNavigateToSession: (cb: (sessionId: string) => void) => () => void
```
to:
```ts
onNavigateToSession: (cb: (payload: { sessionId?: string; route?: string }) => void) => () => void
```

Add the `quickPanel` type:
```ts
quickPanel: {
  hide: () => Promise<void>
  resize: (height: number) => Promise<void>
  focusMain: (payload: { navigate?: string; settings?: string }) => Promise<void>
  getHotkey: () => Promise<string>
  setHotkey: (accelerator: string) => Promise<{ ok: boolean }>
}
```

- [ ] **Step 4: Update the renderer api wrapper**

In `apps/desktop/src/renderer/src/lib/api.ts`, the `onNavigateToSession` wrapper currently passes `(sessionId: string) => void`. Change it to pass the full payload:

Find (around line 66):
```ts
  onNavigateToSession: (cb: (sessionId: string) => void): (() => void) => window.swarm.onNavigateToSession(cb),
```

Replace with:
```ts
  onNavigateToSession: (cb: (payload: { sessionId?: string; route?: string }) => void): (() => void) =>
    window.swarm.onNavigateToSession(cb),
```

- [ ] **Step 5: Update the renderer event subscription to handle route**

In `apps/desktop/src/renderer/src/hooks/use-events-subscription.ts`, the existing `open` callback takes `sessionId: string`. Change it to accept the full payload and branch:

Find (around line 62-69):
```ts
  useEffect(() => {
    const open = (sessionId: string): void => {
      void navigate({ to: '/session/$sessionId', params: { sessionId } })
    }
    void swarmApi.consumePendingDeepLink().then((d) => {
      if (d) open(d.sessionId)
    })
    return swarmApi.onNavigateToSession(open)
  }, [navigate])
```

Replace with:
```ts
  useEffect(() => {
    const open = (payload: { sessionId?: string; route?: string }): void => {
      if (payload.sessionId) {
        void navigate({ to: '/session/$sessionId', params: { sessionId: payload.sessionId } })
      } else if (payload.route) {
        void navigate({ to: payload.route as never })
      }
    }
    void swarmApi.consumePendingDeepLink().then((d) => {
      if (d) open({ sessionId: d.sessionId })
    })
    return swarmApi.onNavigateToSession(open)
  }, [navigate])
```

- [ ] **Step 6: Verify typecheck passes**

Run (from `apps/desktop`):
```bash
pnpm run typecheck:node && pnpm run typecheck:web
```
Expected: PASS — no new type errors (pre-existing `research.ts:128` error is unrelated).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/renderer/src/lib/api.ts apps/desktop/src/renderer/src/hooks/use-events-subscription.ts
git commit -m "feat(quick-panel): add preload bridge + extend swarm:navigate with route field"
```

---

## Task 6: Main Process Wiring

Wires everything together in `main/index.ts`: create the window, init the shortcut, wire IPC, dispose on quit.

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/quick-panel/index.ts`

**Interfaces:**
- Produces: `initQuickPanel(): { dispose: () => void }` — called from `main/index.ts` after `createMainWindow()`.

- [ ] **Step 1: Write the init module**

Create `apps/desktop/src/main/quick-panel/index.ts`:

```ts
// Orchestrator: creates the panel window, initializes the shortcut manager,
// and wires the IPC handlers. Returns a dispose() for app shutdown.
import { paths } from '../constants'
import { wireQuickPanelIpc } from './ipc'
import { createShortcutManager } from './shortcut'
import { createQuickPanelWindow, toggleQuickPanel } from './quick-panel-window'
import { createQuickPanelStore } from './store'

import { createLogger } from '@shared/logger'

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
```

- [ ] **Step 2: Wire into main/index.ts**

In `apps/desktop/src/main/index.ts`, add the import at the top (after the other `quick-panel`-adjacent imports, near line 12):

```ts
import { initQuickPanel } from './quick-panel'
```

Then, after the `createMainWindow()` call (around line 226), add:

```ts
  const quickPanel = initQuickPanel()
```

And in the `before-quit` handler (around line 210), add `quickPanel.dispose()` alongside the other dispose calls:

```ts
  app.on('before-quit', () => {
    quickPanel.dispose()
    wsHost?.dispose()
    serviceClient.disconnect()
    serviceProcess.kill()
  })
```

- [ ] **Step 3: Verify the app starts**

Run (from repo root):
```bash
pnpm --filter @swarm/desktop dev
```
Expected: app starts without errors. The quick panel window is created (hidden). Pressing ⌘⇧Space (macOS) toggles a blank frameless window. Check the log file (`~/.swarm-agents/swarm-dev.log`) for `quick panel initialized` and `quick panel hotkey registered`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/quick-panel/index.ts apps/desktop/src/main/index.ts
git commit -m "feat(quick-panel): wire init into main process bootstrap"
```

---

## Task 7: Renderer Route + Root Layout Guard

Adds the `/quick-panel` route and modifies `__root.tsx` to skip the main-window chrome for that route.

**Files:**
- Create: `apps/desktop/src/renderer/src/routes/quick-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/routes/__root.tsx`

**Interfaces:**
- Produces: `QuickPanelRoute` component rendered at `/quick-panel`.

- [ ] **Step 1: Create the route file**

Create `apps/desktop/src/renderer/src/routes/quick-panel.tsx`:

```tsx
// /quick-panel — the floating panel route. Rendered inside a frameless
// BrowserWindow (see main/quick-panel/quick-panel-window.ts). Does NOT use the
// main-window layout (TitleBar / AppRail / Sidebar) — __root.tsx detects this
// route and renders only <EventsBridge /> + <Outlet />.
import { createFileRoute } from '@tanstack/react-router'

import { EventsBridge } from '@/components/events-bridge'
import { QuickPanel } from '@/components/quick-panel/quick-panel'

export const Route = createFileRoute('/quick-panel')({
  component: QuickPanelRoute,
})

function QuickPanelRoute(): React.JSX.Element {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <EventsBridge />
      <QuickPanel />
    </div>
  )
}
```

- [ ] **Step 2: Modify __root.tsx to skip chrome for /quick-panel**

In `apps/desktop/src/renderer/src/routes/__root.tsx`, import `useMatches` from `@tanstack/react-router` (add to the existing import on line 3):

```ts
import { createRootRoute, Outlet, useMatches } from '@tanstack/react-router'
```

Then in `RootLayout`, before the return statement, add the quick-panel guard:

```tsx
function RootLayout(): React.JSX.Element {
  const loadSessions = useLoadSessions()
  const matches = useMatches()
  const isQuickPanel = matches.some((m) => m.routeId === '/quick-panel')

  useEffect(() => {
    loadSessions.mutate()
  }, [])

  // The quick-panel route is a frameless floating window — skip the main-window
  // chrome (TitleBar / AppRail / Sidebar / SettingsDialog / SessionSearchDialog).
  // EventsBridge is mounted inside the route component itself so swarm:event
  // subscriptions work.
  if (isQuickPanel) {
    return <Outlet />
  }

  return (
    <>
      {/* ... existing main-window layout ... */}
```

- [ ] **Step 3: Create a placeholder QuickPanel component**

Create `apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx`:

```tsx
// Placeholder — real implementation arrives in Task 9.
export function QuickPanel(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
      Quick Panel
    </div>
  )
}
```

- [ ] **Step 4: Verify the route loads**

Run the dev server, trigger the global hotkey. Expected: the floating window shows "Quick Panel" text. No main-window chrome.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/routes/quick-panel.tsx apps/desktop/src/renderer/src/routes/__root.tsx apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx
git commit -m "feat(quick-panel): add /quick-panel route with root layout guard"
```

---

## Task 8: Quick Panel State Machine

The state machine hook that manages mode switching (palette vs chat), slash command detection, and query state.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/quick-panel/use-quick-panel-state.ts`

**Interfaces:**
- Consumes: `getScope` from `@/lib/palette/scope`, `usePaletteData` from `@/hooks/use-palette-data`, `buildItems` + `Callbacks` from `@/lib/palette/build-items`.
- Produces: `useQuickPanelState()` returning `{ mode, query, setQuery, scope, sections, flat, selIndex, setSelIndex, selected, onKeyDown, sessionId, enterChatMode, slashItems, showSlashList }`.

**Key design decision — slash vs file-scope conflict:** The existing `getScope` maps `/` prefix to the `file` scope. But `/agent` is a slash command, not a file search. Resolution: check for slash commands FIRST. If the query starts with `/` and matches a known slash command prefix, show the slash list. Only if it doesn't match (e.g. `/some-other-text`) does it fall through to `getScope`'s `file` scope.

- [ ] **Step 1: Write the state machine**

Create `apps/desktop/src/renderer/src/components/quick-panel/use-quick-panel-state.ts`:

```ts
// State machine for the quick panel. Two modes:
//   palette — reuses the existing buildItems + getScope pipeline.
//   chat    — mini agent conversation (entered via /agent + Tab).
//
// Slash commands: when the query starts with '/', we check if it matches a
// known slash command prefix before falling through to getScope's file scope.
// This resolves the conflict: '/' is both the file-scope prefix AND the slash
// command trigger. Slash commands take priority.
import { useEffect, useMemo, useState } from 'react'

import { usePaletteData } from '@/hooks/use-palette-data'
import { type BuildInputs, type Callbacks, buildItems } from '@/lib/palette/build-items'
import { getScope } from '@/lib/palette/scope'
import { selectPalette } from '@/lib/palette/select-palette'
import { swarmApi } from '@/lib/api'

export type QuickPanelMode = 'palette' | 'chat'

export type SlashCommand = {
  id: string
  label: string
  desc: string
}

// MVP: only /agent. Extensible shape — add entries here to surface more.
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'agent', label: '/agent', desc: '进入对话模式' },
]

function matchingSlashCommands(query: string): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const lower = query.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.label.toLowerCase().startsWith(lower))
}

export type QuickPanelState = {
  mode: QuickPanelMode
  query: string
  setQuery: (q: string) => void
  scope: ReturnType<typeof getScope>['mode']
  sections: ReturnType<typeof selectPalette>['sections']
  flat: ReturnType<typeof selectPalette>['flat']
  selIndex: number
  setSelIndex: (i: number) => void
  selected: ReturnType<typeof selectPalette>['flat'][number] | null
  onKeyDown: (e: React.KeyboardEvent) => void
  sessionId: string | null
  showSlashList: boolean
  slashItems: SlashCommand[]
  pickSlashCommand: (cmd: SlashCommand) => void
}

export function useQuickPanelState(args: {
  inputs: BuildInputs
  cb: Callbacks
}): QuickPanelState {
  const { inputs, cb } = args
  const [mode, setMode] = useState<QuickPanelMode>('palette')
  const [query, setQuery] = useState('')
  const [selIndex, setSelIndex] = useState(0)
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Slash command matching — checked before getScope.
  const slashItems = useMemo(() => matchingSlashCommands(query), [query])
  const showSlashList = slashItems.length > 0

  // Palette scope + items (only computed in palette mode).
  const { mode: scope, term } = getScope(query)
  const items = useMemo(() => buildItems(scope, term, inputs, cb), [scope, term, inputs, cb])
  const { sections, flat } = useMemo(() => selectPalette(scope, items), [scope, items])

  useEffect(() => {
    setSelIndex(0)
  }, [query])

  const selected = flat[selIndex] ?? null

  const pickSlashCommand = (cmd: SlashCommand): void => {
    if (cmd.id === 'agent') {
      setMode('chat')
      setQuery('')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Esc always closes the panel (both modes).
    if (e.key === 'Escape') {
      e.preventDefault()
      void swarmApi.quickPanelHide()
      return
    }

    // Slash list: Tab or Enter picks the highlighted slash command.
    if (showSlashList && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault()
      const target = slashItems[selIndex] ?? slashItems[0]
      if (target) pickSlashCommand(target)
      return
    }

    // Palette mode keyboard (arrow nav + enter).
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selected?.run()
    }
  }

  return {
    mode,
    query,
    setQuery,
    scope,
    sections,
    flat,
    selIndex,
    setSelIndex,
    selected,
    onKeyDown,
    sessionId,
    showSlashList,
    slashItems,
    pickSlashCommand,
  }
}
```

- [ ] **Step 2: Add the quickPanelHide wrapper to swarmApi**

In `apps/desktop/src/renderer/src/lib/api.ts`, add to the `swarmApi` object:

```ts
  quickPanelHide: (): Promise<void> => window.swarm.quickPanel.hide(),
  quickPanelResize: (height: number): Promise<void> => window.swarm.quickPanel.resize(height),
  quickPanelFocusMain: (payload: { navigate?: string; settings?: string }): Promise<void> =>
    window.swarm.quickPanel.focusMain(payload),
  quickPanelGetHotkey: (): Promise<string> => window.swarm.quickPanel.getHotkey(),
  quickPanelSetHotkey: (accelerator: string): Promise<{ ok: boolean }> =>
    window.swarm.quickPanel.setHotkey(accelerator),
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/quick-panel/use-quick-panel-state.ts apps/desktop/src/renderer/src/lib/api.ts
git commit -m "feat(quick-panel): add state machine with slash command + mode switching"
```

---

## Task 9: Quick Panel Component (Palette + Input + Results)

The top-level component wiring the state machine to the UI: input box, slash command popover, palette results.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-input.tsx`
- Create: `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-results.tsx`
- Modify: `apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx`

**Interfaces:**
- Consumes: `useQuickPanelState` from Task 8, `usePaletteData` from existing hooks, `PaletteResults` rendering patterns from existing `palette/palette-results.tsx`.

- [ ] **Step 1: Create the input component**

Create `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-input.tsx`:

```tsx
import { Search } from 'lucide-react'

import type { SlashCommand } from './use-quick-panel-state'

type Props = {
  query: string
  onQueryChange: (q: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  showSlashList: boolean
  slashItems: SlashCommand[]
  selIndex: number
}

export function QuickPanelInput(props: Props): React.JSX.Element {
  return (
    <div className="relative flex items-center gap-2 border-border/60 border-b px-4 py-3">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        className="flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => props.onQueryChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        placeholder="搜索、输入命令,或 / 进入对话…"
        value={props.query}
      />
      {/* Slash command popover */}
      {props.showSlashList && (
        <div className="absolute top-full left-0 z-50 w-full border-border/60 border-b bg-popover/95 backdrop-blur-md">
          {props.slashItems.map((cmd, i) => (
            <div
              className={`flex items-center gap-2 px-4 py-2 text-sm ${i === props.selIndex ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
              key={cmd.id}
            >
              <span className="font-mono text-primary">{cmd.label}</span>
              <span className="text-muted-foreground text-xs">{cmd.desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create the results component**

Create `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-results.tsx`:

```tsx
// Renders the palette results list for the quick panel. Reuses the PaletteItem
// and PaletteSection types from the existing palette, but with a simpler
// single-column layout (no preview aside — the panel is too narrow).
import { ChevronRight } from 'lucide-react'

import type { PaletteItem, PaletteSection } from '@/lib/palette/types'

type Props = {
  flat: PaletteItem[]
  sections: PaletteSection[]
  selIndex: number
  onSetSelIndex: (i: number) => void
}

export function QuickPanelResults(props: Props): React.JSX.Element | null {
  if (props.flat.length === 0) return null

  return (
    <div className="cmdscroll min-h-0 flex-1 overflow-y-auto py-1">
      {props.sections.map((section) => {
        if (section.items.length === 0) return null
        return (
          <div key={section.heading}>
            <div className="px-4 pt-2 pb-1 text-muted-foreground text-xs">{section.heading}</div>
            {section.items.map((item) => {
              const globalIndex = props.flat.indexOf(item)
              const isSelected = globalIndex === props.selIndex
              return (
                <button
                  className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-sm ${isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'}`}
                  key={item.id}
                  onClick={() => {
                    props.onSetSelIndex(globalIndex)
                    item.run()
                  }}
                  onMouseEnter={() => props.onSetSelIndex(globalIndex)}
                  type="button"
                >
                  <ChevronRight className="size-3.5 shrink-0 opacity-50" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.subtitle && (
                    <span className="shrink-0 text-muted-foreground text-xs">{item.subtitle}</span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Implement the top-level QuickPanel component**

Replace the placeholder in `apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx`:

```tsx
// Top-level quick panel component. In palette mode: input + slash list + results.
// In chat mode: delegates to QuickPanelChat (Task 10).
import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { usePaletteData } from '@/hooks/use-palette-data'
import { useSubmitPrompt } from '@/hooks/use-messages'
import { useTheme } from 'next-themes'
import type { Callbacks } from '@/lib/palette/build-items'
import { useComposerDefaults } from '@/stores/composer-defaults'
import { swarmApi } from '@/lib/api'

import { QuickPanelChat } from './quick-panel-chat'
import { QuickPanelInput } from './quick-panel-input'
import { QuickPanelResults } from './quick-panel-results'
import { useQuickPanelState } from './use-quick-panel-state'

const THEME_ORDER = ['system', 'light', 'dark'] as const

export function QuickPanel(): React.JSX.Element {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const setComposerAgent = useComposerDefaults((s) => s.setAgentType)
  const submitPrompt = useSubmitPrompt()
  const inputs = usePaletteData(true)

  const cb: Callbacks = useMemo(
    () => ({
      navigate: (to) => {
        void swarmApi.quickPanelFocusMain({ navigate: to })
      },
      openSettings: (section) => {
        void swarmApi.quickPanelFocusMain({ settings: section })
      },
      cycleTheme: () => {
        const current = (theme ?? 'system') as (typeof THEME_ORDER)[number]
        const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]
        setTheme(next)
      },
      exportMarkdown: (sessionId) => {
        if (sessionId) void swarmApi.exportSessionMarkdown(sessionId)
      },
      setComposerAgent: (id) => {
        setComposerAgent(id)
        void swarmApi.quickPanelFocusMain({ navigate: '/' })
      },
      openArtifact: (ref) => {
        void window.swarm.openPath(ref)
      },
      submitPrompt: async (prompt, agentType) => {
        const r = await submitPrompt.mutateAsync({ prompt, options: { agentType }, forceNew: true })
        void swarmApi.quickPanelFocusMain({ navigate: `/session/${r.sessionId}` })
        return r
      },
    }),
    [theme, setTheme, setComposerAgent, submitPrompt]
  )

  const state = useQuickPanelState({ inputs, cb })

  if (state.mode === 'chat') {
    return <QuickPanelChat />
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-popover/82 backdrop-blur-[40px]">
      <QuickPanelInput
        onKeyDown={state.onKeyDown}
        onQueryChange={state.setQuery}
        query={state.query}
        selIndex={state.selIndex}
        showSlashList={state.showSlashList}
        slashItems={state.slashItems}
      />
      <QuickPanelResults
        flat={state.flat}
        onSetSelIndex={state.setSelIndex}
        sections={state.sections}
        selIndex={state.selIndex}
      />
    </div>
  )
}
```

- [ ] **Step 4: Create a placeholder QuickPanelChat**

Create `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-chat.tsx`:

```tsx
// Placeholder — real implementation in Task 10.
export function QuickPanelChat(): React.JSX.Element {
  return (
    <div className="flex h-svh items-center justify-center text-muted-foreground text-sm">
      Chat mode
    </div>
  )
}
```

- [ ] **Step 5: Verify palette mode works**

Run dev, trigger hotkey. Expected: panel shows input. Typing shows palette results. Clicking a result closes the panel and navigates the main window. Typing `/` shows the slash list with `/agent`. Tab on `/agent` switches to "Chat mode" placeholder.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/quick-panel/quick-panel-input.tsx apps/desktop/src/renderer/src/components/quick-panel/quick-panel-results.tsx apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx apps/desktop/src/renderer/src/components/quick-panel/quick-panel-chat.tsx
git commit -m "feat(quick-panel): implement palette mode with input, slash list, results"
```

---

## Task 10: Chat Mode Mini-Session

The chat mode: a mini conversation view that creates a session on first submit, streams responses, and supports multi-turn.

**Key constraint:** `MessageRecord` has NO `content` or `role` field. The displayable text lives in `task.events[]` and is extracted by the existing `taskSegments(task)` function (`@/lib/task-segments.ts`), which returns `Segment[]` with `{ kind: 'user' | 'assistant', text: string, ... }`. The chat component must use `taskSegments` to render bubbles — NOT `m.content` / `m.role`.

Also: `MessageRecord.status` values are `'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled'` (NOT `'ended'` / `'interrupted'`).

**Files:**
- Replace: `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-chat.tsx`

**Interfaces:**
- Consumes: `swarmApi.createSession`, `swarmApi.submitPrompt`, `useMessages` (for streaming via the shared query cache), `useSessionsStore`, `taskSegments` from `@/lib/task-segments`.

- [ ] **Step 1: Implement the chat component**

Replace `apps/desktop/src/renderer/src/components/quick-panel/quick-panel-chat.tsx`:

```tsx
// Chat mode mini-session. On first Enter: creates a session + submits the
// prompt. Subsequent Enter appends to the same session. Streaming is driven by
// the shared MESSAGES_KEY query cache (updated by EventsBridge's swarm:event
// subscription). Esc closes the panel.
//
// Text extraction: MessageRecord has no content/role fields. We reuse
// taskSegments() (the same pure function the main thread uses) to extract
// user/assistant text segments from task.events[]. Only user + assistant
// segments are rendered; tool/reasoning/error segments are skipped for the
// mini view.
import { useEffect, useMemo, useRef, useState } from 'react'

import { useMessages } from '@/hooks/use-messages'
import { taskSegments } from '@/lib/task-segments'
import { useSessionsStore } from '@/stores/sessions'
import { swarmApi } from '@/lib/api'

const DEFAULT_FORMATION = 'ceo'

// Statuses where the agent is actively producing output.
const STREAMING_STATUSES = new Set(['running', 'pending', 'awaiting_user'])

type Bubble = {
  key: string
  role: 'user' | 'assistant'
  text: string
}

export function QuickPanelChat(): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const allMessages = useMessages()
  const selectSession = useSessionsStore((s) => s.select)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Filter + sort messages to the panel's session (by task.order for correct
  // turn sequence, same as conversation-thread.tsx).
  const tasks = useMemo(
    () =>
      (sessionId ? allMessages.filter((m) => m.sessionId === sessionId) : []).sort(
        (a, b) => a.order - b.order
      ),
    [allMessages, sessionId]
  )

  // Flatten tasks into user/assistant text bubbles via taskSegments.
  const bubbles = useMemo<Bubble[]>(() => {
    const out: Bubble[] = []
    for (const task of tasks) {
      for (const seg of taskSegments(task)) {
        if (seg.kind === 'user' || seg.kind === 'assistant') {
          out.push({ key: seg.key, role: seg.kind, text: seg.text })
        }
      }
    }
    return out
  }, [tasks])

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [bubbles])

  // Detect when streaming ends (last task is no longer in a streaming status).
  useEffect(() => {
    const last = tasks[tasks.length - 1]
    if (last && STREAMING_STATUSES.has(last.status)) {
      setIsStreaming(true)
    } else {
      setIsStreaming(false)
    }
  }, [tasks])

  // Resize the panel to fit content (grows with bubbles, capped at 480 by main).
  useEffect(() => {
    const height = Math.min(96 + bubbles.length * 60, 480)
    void swarmApi.quickPanelResize(height)
  }, [bubbles.length])

  const handleSubmit = async (): Promise<void> => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    let sid = sessionId
    if (!sid) {
      const created = await swarmApi.createSession()
      sid = created.sessionId
      setSessionId(sid)
      selectSession(sid)
    }

    setInput('')
    setIsStreaming(true)
    await swarmApi.submitPrompt(sid, trimmed, undefined, { agentType: DEFAULT_FORMATION })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void swarmApi.quickPanelHide()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-popover/82 backdrop-blur-[40px]">
      {/* Message list */}
      <div className="cmdscroll min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={scrollRef}>
        {bubbles.length === 0 && (
          <div className="text-muted-foreground py-8 text-center text-sm">输入消息开始对话…</div>
        )}
        {bubbles.map((b) => (
          <div className="mb-3" key={b.key}>
            <div className="text-muted-foreground mb-0.5 text-xs">
              {b.role === 'user' ? '你' : 'Agent'}
            </div>
            <div
              className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${b.role === 'user' ? 'bg-primary/10' : 'bg-muted/40'}`}
            >
              {b.text || (isStreaming && b.role === 'assistant' ? '…' : '')}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-border/60 border-t px-4 py-3">
        <input
          autoFocus
          className="bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
          disabled={isStreaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isStreaming ? 'Agent 正在回复…' : '输入消息,Enter 发送,Esc 关闭…'}
          value={input}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify chat mode works**

Run dev, trigger hotkey, type `/`, Tab on `/agent`. Expected: panel switches to chat mode. Type a prompt + Enter. The session is created, the prompt is submitted, and streaming output appears. Esc closes the panel. The session appears in the main window's session list.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/quick-panel/quick-panel-chat.tsx
git commit -m "feat(quick-panel): implement chat mode mini-session with streaming"
```

---

## Task 11: Settings Section

Adds a "快捷面板" section to the settings dialog for viewing and rebinding the hotkey.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/quick-panel-settings-view.tsx`
- Modify: `apps/desktop/src/renderer/src/stores/settings-dialog.ts`

**Interfaces:**
- Consumes: `swarmApi.quickPanelGetHotkey`, `swarmApi.quickPanelSetHotkey`.

- [ ] **Step 1: Create the settings view**

Create `apps/desktop/src/renderer/src/components/views/quick-panel-settings-view.tsx`:

```tsx
// Settings view for the quick panel: displays the current global hotkey and
// lets the user rebind it by pressing a new key combination.
import { useEffect, useState } from 'react'
import { Keyboard } from 'lucide-react'

import { swarmApi } from '@/lib/api'

// Convert an Electron accelerator string to a human-readable label.
function acceleratorToLabel(accel: string): string {
  return accel
    .replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Shift', '⇧')
    .replace('Alt', process.platform === 'darwin' ? '⌥' : 'Alt')
    .replace(/\+/g, ' ')
    .replace('Space', 'Space')
}

// Convert a KeyboardEvent to an Electron accelerator string.
function eventToAccelerator(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey) parts.push('Command')
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  // Ignore pure modifier presses — wait for an actual key.
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return ''
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
  parts.push(key)
  // Use CommandOrControl on macOS so it works cross-platform.
  if (process.platform === 'darwin' && parts.includes('Command')) {
    const idx = parts.indexOf('Command')
    parts[idx] = 'CommandOrControl'
  }
  return parts.join('+')
}

export function QuickPanelSettingsView(): React.JSX.Element {
  const [hotkey, setHotkey] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void swarmApi.quickPanelGetHotkey().then(setHotkey)
  }, [])

  useEffect(() => {
    if (!capturing) return
    const handler = async (e: KeyboardEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()
      const accel = eventToAccelerator(e)
      if (!accel) return // pure modifier, wait for a real key
      const result = await swarmApi.quickPanelSetHotkey(accel)
      if (result.ok) {
        setHotkey(accel)
        setError(null)
      } else {
        setError('该快捷键已被系统或其他应用占用')
      }
      setCapturing(false)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [capturing])

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="mb-1 text-foreground text-lg font-semibold">快捷面板</h2>
        <p className="text-muted-foreground text-sm">
          全局快捷键唤起快捷面板,即使应用不在前台也能响应。
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Keyboard className="size-4 text-muted-foreground" />
          <span className="text-sm">当前快捷键</span>
        </div>
        <kbd className="rounded bg-muted px-3 py-1.5 font-mono text-sm">
          {hotkey ? acceleratorToLabel(hotkey) : '未设置'}
        </kbd>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          onClick={() => {
            setCapturing(true)
            setError(null)
          }}
          type="button"
        >
          {capturing ? '按下新的快捷键…' : '重新绑定'}
        </button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Register the settings section**

In `apps/desktop/src/renderer/src/stores/settings-dialog.ts`:

Add `Command` to the lucide-react import (it's already imported as `Settings` — add `Command` alongside, or use a different icon like `Keyboard`):

In the import block (around line 6-21), add `Keyboard`:
```ts
  Keyboard,
```

Add the import for the new view (after the other view imports, around line 34):
```ts
import { QuickPanelSettingsView } from '@/components/views/quick-panel-settings-view'
```

Add `'quick-panel'` to the `SettingsSection` type:
```ts
export type SettingsSection =
  | 'general'
  | 'providers'
  // ... existing entries ...
  | 'remote'
  | 'quick-panel'
```

Add the entry to `SECTIONS_REGISTRY` (after the `general` entry, or in the `通用` group):
```ts
  { key: 'quick-panel', label: '快捷面板', group: '通用', iconBg: '#8e8e93', icon: Keyboard, View: QuickPanelSettingsView },
```

- [ ] **Step 3: Verify settings UI**

Run dev, open Settings (⌘,), find "快捷面板" section. Expected: shows current hotkey label, "重新绑定" button enters capture mode, pressing a new combo updates the hotkey.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/quick-panel-settings-view.tsx apps/desktop/src/renderer/src/stores/settings-dialog.ts
git commit -m "feat(quick-panel): add settings section for hotkey rebinding"
```

---

## Task 12: Panel Resize on Palette Results

Wire up the dynamic height resize for palette mode so the panel grows/shrinks with the number of results.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx`

- [ ] **Step 1: Add resize effect for palette mode**

In `apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx`, add a `useEffect` inside the `QuickPanel` component (after the `state` is computed, before the early return for chat mode) that resizes the panel based on the number of palette results:

```tsx
import { useEffect, useMemo, useState } from 'react'
```

Add after `const state = useQuickPanelState(...)`:

```tsx
  // Resize the panel to fit palette results. Each result row is ~32px; the
  // input is ~52px. Cap at 480 (enforced by main's resizeQuickPanel).
  useEffect(() => {
    if (state.mode !== 'palette') return
    const inputHeight = 52
    const rowHeight = 32
    const resultsHeight = state.flat.length * rowHeight
    void swarmApi.quickPanelResize(inputHeight + resultsHeight)
  }, [state.mode, state.flat.length])
```

- [ ] **Step 2: Verify resize**

Run dev, trigger hotkey. Expected: panel starts short (just input). Typing shows results and the panel grows. Clearing the query shrinks it back. Entering chat mode resizes it (Task 10's effect handles that).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx
git commit -m "feat(quick-panel): dynamic height resize for palette results"
```

---

## Task 13: Export Markdown Bridge

The palette's `exportMarkdown` callback references `swarmApi.exportSessionMarkdown`, but the quick panel's context has no "current session." Wire it to export the most recently active session via `focusMain`.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx`

- [ ] **Step 1: Fix the exportMarkdown callback**

In the `cb` object in `quick-panel.tsx`, the `exportMarkdown` callback currently calls `swarmApi.exportSessionMarkdown(sessionId)` but doesn't close the panel. Update it to also hide the panel:

```ts
      exportMarkdown: (sessionId) => {
        if (sessionId) {
          void swarmApi.exportSessionMarkdown(sessionId)
          void swarmApi.quickPanelHide()
        }
      },
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/renderer/src/components/quick-panel/quick-panel.tsx
git commit -m "fix(quick-panel): hide panel on markdown export"
```

---

## Task 14: Final Integration Verification

Manual end-to-end verification of the complete feature.

- [ ] **Step 1: Verify the full flow**

Run dev. Test each path:

1. **Global hotkey toggle**: Press ⌘⇧Space (macOS). Panel appears centered. Press again — hides.
2. **Palette search**: Type "设置" — results filter. Click "打开设置" — panel hides, main window opens settings.
3. **Slash command**: Type `/` — slash list appears with `/agent`. Press Tab — enters chat mode.
4. **Chat mode**: Type a prompt, Enter — session created, streaming output appears. Esc closes panel.
5. **Session persistence**: Open main window — the chat session appears in the session list.
6. **Multi-turn**: Reopen panel, type `/agent` + Tab, type another prompt — appends to a new session.
7. **Settings rebind**: Open Settings → 快捷面板. Click 重新绑定, press a new combo (e.g. ⌘⇧P). Verify the new hotkey works.
8. **Blur hide**: Click outside the panel — it hides.
9. **Background task**: Start a chat, Esc to hide. Check main window session list — task continues running.

- [ ] **Step 2: Run the test suite**

Run (from `apps/desktop`):
```bash
cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run src/main/quick-panel/
```
Expected: all quick-panel tests pass.

- [ ] **Step 3: Run typecheck**

Run (from `apps/desktop`):
```bash
pnpm run typecheck:node && pnpm run typecheck:web
```
Expected: no new type errors (pre-existing `research.ts:128` error is unrelated).

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "feat(quick-panel): final integration verification complete"
```
