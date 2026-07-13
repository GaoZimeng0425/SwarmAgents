# Quick Panel — Global Hotkey Floating Panel

**Date:** 2026-07-14
**Status:** Design approved, pending implementation plan

## Summary

A Spotlight/Raycast-style floating panel that responds to a system-wide global
hotkey even when the app is not active. The panel provides two modes:

1. **Palette mode** — quick-launch shortcuts, reusing the existing ⌘K command
   palette's `buildItems` + `usePaletteData` logic. Selecting an item closes the
   panel and navigates the main window.
2. **Chat mode** — triggered by typing `/` to open a slash-command list, then
   picking `/agent` + Tab. Runs a full mini conversation inside the panel with
   streaming output. Results are saved to the session list as a normal session.

## Confirmed Decisions

| Decision | Choice |
|----------|--------|
| Agent chat display location | Full mini-session inside the panel |
| Global hotkey | Configurable in settings, default `CommandOrControl+Shift+Space` |
| Relationship to ⌘K palette | Independent floating window, reuses palette item logic |
| Esc / blur behavior | Hide panel; running agent tasks continue in background |
| Session ownership | Each chat creates a new session (like "new chat" in main window) |
| `/agent` trigger | Slash-command list when input starts with `/`; pick `/agent` + Tab |
| Esc in chat mode | Closes the panel (does not return to palette) |
| Navigation channel | Extend `swarm:navigate` payload with optional `route` field |

## Architecture

```
┌─ Main process ──────────────────────────────────────────┐
│  QuickPanelWindow (new)                                  │
│    - frameless BrowserWindow, centered, blur-to-hide     │
│    - show() / hide() / toggle()                          │
│  GlobalShortcut (new)                                    │
│    - configurable hotkey → toggle()                      │
│    - persisted in userData/quick-panel.json              │
│  QuickPanelIpc (new)                                     │
│    - swarm:quickPanel:hide / resize / focusMain          │
│    - swarm:quickPanel:getHotkey / setHotkey              │
└──────────────────────────────────────────────────────────┘
          │  preload fully reused (window.swarm.*)
          ▼
┌─ Renderer (panel window) ───────────────────────────────┐
│  Route /quick-panel (new)                                │
│    <QuickPanel />                                        │
│      ├─ mode: 'palette' | 'chat'                        │
│      ├─ palette: buildItems + usePaletteData (reused)    │
│      │    callbacks → focusMain (close panel + navigate) │
│      └─ chat: mini session                               │
│           ├─ lightweight input (reuses useSubmitPrompt)  │
│           ├─ message list (subscribes swarm:event)       │
│           └─ Enter → createSession + submitPrompt        │
└──────────────────────────────────────────────────────────┘
          │  IPC (swarm:submitPrompt / swarm:event)
          ▼
┌─ Service process (utilityProcess, unchanged) ───────────┐
│  SessionService.createSession / submitPrompt             │
│  Events → Broadcaster → BrowserWindow.getAllWindows()    │
│  → panel auto-receives swarm:event ✓                    │
└──────────────────────────────────────────────────────────┘
```

### Three key reuse points (verified in codebase)

1. **Event broadcast already covers the panel**: `main/index.ts:144` iterates
   `BrowserWindow.getAllWindows()` to send `swarm:event`. The panel, as a new
   window, automatically receives streaming events — zero changes needed.
2. **Preload fully reused**: `window.swarm.submitPrompt`, `createSession`,
   `subscribeEvents` are all already exposed; the panel calls them directly.
3. **Palette logic reused**: `buildItems` (pure function) + `usePaletteData`
   (hook) are called directly; only the `Callbacks` implementation changes.

## Component Design

### 1. Floating Window (main process)

**File**: `apps/desktop/src/main/quick-panel/quick-panel-window.ts`

Window options:
- `width: 640`, `height: 96` (initial, palette-only height)
- `maxHeight: 480` (chat mode or many results)
- `frame: false`, `resizable: false`, `skipTaskbar: true`, `alwaysOnTop: true`
- macOS: `transparent: true`, `vibrancy: 'menu'`, `visualEffectState: 'active'`
- Same `webPreferences` as main window (same preload, `sandbox: false`,
  `backgroundThrottling: false`, `spellcheck: false`)

Loading: dev → `ELECTRON_RENDERER_URL + '#/quick-panel'`; prod →
`loadFile(renderer/index.html) + '#/quick-panel'`. Same bundle, hash-routed.

Show/hide behavior:
- `toggle()`: if visible → `hide()`; else `show()` + `focus()`
- `show()`: recenter on the display nearest the cursor
  (`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`)
- `hide()`: `win.hide()` only, never `destroy()` — window is reused
- `win.on('blur', () => hide())` — auto-hide on focus loss

Lifecycle:
- Created at `app.whenReady()` with `show: false` (avoids first-toggle latency)
- Persists for app lifetime; `hide()` only hides
- Destroyed with app on quit

Dynamic height: renderer sends `swarm:quickPanel:resize(height)` IPC → main
calls `win.setSize(640, height)`. Keeps the panel growing with content like
Spotlight, no internal scrollbar until maxHeight.

Logging: `createLogger({ process: 'main' }).child({ component: 'quick-panel-window' })`
at show/hide/resize/focusMain per AGENTS.md §5.

### 2. Global Shortcut + Settings

**File**: `apps/desktop/src/main/quick-panel/shortcut.ts` +
`apps/desktop/src/main/quick-panel/store.ts`

Config storage: `userData/quick-panel.json`, plaintext JSON (same style as
`calendar/store.ts`, `web-search/store.ts`). Shape:
`{ "hotkey": "CommandOrControl+Shift+Space" }`.

Registration:
```ts
let currentAccelerator: string | null = null

function registerQuickPanelHotkey(accelerator: string, onToggle: () => void): boolean {
  if (currentAccelerator) globalShortcut.unregister(currentAccelerator)
  const ok = globalShortcut.register(accelerator, onToggle)
  if (ok) {
    currentAccelerator = accelerator
    log.info({ msg: 'quick panel hotkey registered', accelerator })
  } else {
    log.error({ msg: 'quick panel hotkey register failed', accelerator })
    currentAccelerator = null
  }
  return ok
}
```

Settings IPC:
- `swarm:quickPanel:getHotkey` → `string`
- `swarm:quickPanel:setHotkey(accelerator)` → `{ ok: boolean }` (write json +
  re-register; returns `ok: false` if OS rejects the accelerator)

Settings UI: new "快捷面板" section in the existing settings dialog:
- Hotkey display field (e.g. `⌘⇧Space`)
- "重新绑定" button → capture mode (listens for next keypress → builds
  accelerator string → calls `setHotkey`)
- On `ok: false`: show "该快捷键已被系统或其他应用占用"

Lifecycle: register at `app.whenReady()`; unregister at `app.will-quit`.

No format pre-validation — rely on `globalShortcut.register` return value.

### 3. Renderer — Route + QuickPanel Component

**Route**: `apps/desktop/src/renderer/src/routes/quick-panel.tsx`

The panel route does **not** use `__root.tsx`'s full layout (TitleBar / AppRail
/ SidebarProvider / Toaster). In `__root.tsx` `RootLayout`:
```tsx
const matches = useMatches()
const isQuickPanel = matches.some((m) => m.routeId === '/quick-panel')
if (isQuickPanel) {
  return <><EventsBridge /><Outlet /></>  // EventsBridge required for swarm:event
}
// normal main-window layout...
```

`EventsBridge` must stay — it subscribes to `swarm:event` and updates zustand
stores (sessions / messages) that the chat mode depends on.

**Component tree** (`apps/desktop/src/renderer/src/components/quick-panel/`):
```
quick-panel/
  quick-panel.tsx          # top-level: mode switching + layout
  quick-panel-input.tsx    # input + slash command popover
  quick-panel-results.tsx  # palette results list
  quick-panel-chat.tsx     # chat mini-session
  use-quick-panel-state.ts # state machine: query / scope / mode / sessionId
```

**State machine** (`use-quick-panel-state.ts`):
```
mode: 'palette' | 'chat'
query: string
sessionId: string | null   // chat mode only

On input change:
  - query starts with '/' → show slash command list
  - pick '/agent' + Tab → mode = 'chat', clear query
  - query starts with '>' '@' '#' → palette mode, scope-parsed
  - otherwise → palette mode, mixed scope

Esc (any mode) → trigger swarm:quickPanel:hide
```

**Slash command list**: shown when `query` starts with `/`. Extensible shape:
`{ id: 'agent', label: '/agent', desc: '进入对话模式', onPick: () => switchToChat() }`.
MVP has only `/agent`. Select (Tab or click) → enter chat mode, clear input.

**Palette mode Callbacks**: reuses `buildItems` + `usePaletteData`, but
`Callbacks` implementation changes to close-panel + focus-main:
```ts
const cb: Callbacks = {
  navigate: (to) => {
    void window.swarm.quickPanel.focusMain({ navigate: to })
  },
  openSettings: (section) => {
    void window.swarm.quickPanel.focusMain({ settings: section })
  },
  // cycleTheme / setComposerAgent: same — operate via focusMain or direct IPC
  // submitPrompt (hero dispatch): close panel + open session in main window
  submitPrompt: async (prompt, agentType) => {
    const r = await submitPrompt.mutateAsync({ prompt, options: { agentType }, forceNew: true })
    void window.swarm.quickPanel.focusMain({ navigate: `/session/${r.sessionId}` })
    return r
  },
  ...
}
```

**Input**: lightweight `<input>`, does NOT reuse `chat-input.tsx` (which binds
composer state, footer controls, attachments). Submit logic reuses
`useSubmitPrompt` hook.

### 4. Chat Mode Mini-Session

**Trigger**: type `/` → slash list → pick `/agent` + Tab → `mode = 'chat'`,
input cleared and focused.

**UI layout**:
```
┌─────────────────────────────────────┐ 640 × dynamic (max 480)
│  input field                         │  ← bottom-fixed
├─────────────────────────────────────┤
│  message list (scrollable)           │  ← streaming render
│  ┌─ user: prompt ┐                   │
│  └────────────────┘                 │
│  ┌─ assistant: [streaming...] ┐     │
│  └────────────────────────────┘     │
└─────────────────────────────────────┘
```

**Session lifecycle**:
- No session created on entering chat mode (avoids empty sessions polluting the
  list)
- First Enter: `swarm.sessions.create()` → `swarm.submitPrompt(sessionId, prompt)`
  → store `sessionId` in component state for subsequent turns
- Subsequent Enter: `swarm.submitPrompt(sessionId, newPrompt)` appends to same
  session

**Streaming render**:
- `EventsBridge` already subscribes to `swarm:event` → updates `useMessages` /
  `useSessionsStore`
- Chat component reads `useMessages()` for current session's messages
- Assistant streaming token deltas handled by existing store `applyEvent`;
  component just re-renders on store changes
- Window height adjusts via `swarm:quickPanel:resize` up to maxHeight 480, then
  internal scroll

**Agent selection**: defaults to `DEFAULT_FORMATION = 'ceo'` (same as palette
hero dispatch). No agent-switching UI in the panel for MVP.

**Multi-turn**:
- While assistant is streaming, input disabled (Enter no-op) to prevent
  concurrent submissions
- Resumes when message status becomes `ended` / `interrupted`

**Close & resume**:
- Panel hide does not stop the session — `submitPrompt` is async, independent
  of window existence
- Reopening the panel: if a chat session was active, show a "继续上次对话" entry
  (sessionId kept in module-level variable; window is not destroyed so memory
  persists)
- The session is also visible in the main window's session list (it's a normal
  session)

### 5. IPC Interface + Preload Extension

**New channels** (registered in `apps/desktop/src/main/quick-panel/ipc.ts`,
wired by `wireQuickPanelIpc()` called from `main/index.ts`):

| Channel | Direction | Signature | Purpose |
|---------|-----------|-----------|---------|
| `swarm:quickPanel:hide` | r→m | `() => void` | Renderer requests panel hide |
| `swarm:quickPanel:resize` | r→m | `(height: number) => void` | Dynamic height adjust |
| `swarm:quickPanel:focusMain` | r→m | `(payload: { navigate?: string; settings?: string }) => void` | Close panel + show/focus main + navigate |
| `swarm:quickPanel:getHotkey` | r→m | `() => string` | Read current hotkey |
| `swarm:quickPanel:setHotkey` | r→m | `(accelerator: string) => { ok: boolean }` | Write config + re-register |

**`focusMain` implementation** (main process):
```ts
ipcMain.handle('swarm:quickPanel:focusMain', (_e, payload) => {
  getQuickPanelWindow()?.hide()
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (payload.navigate) {
    // Extend swarm:navigate to carry a `route` field for non-session routes
    win.webContents.send('swarm:navigate', { route: payload.navigate })
  }
  if (payload.settings) {
    openSettings({ initialRoute: payload.settings })
  }
})
```

**`swarm:navigate` extension**: payload changes from `{ sessionId: string }` to
`{ sessionId?: string; route?: string }`. Backward-compatible — existing
`deep-link.ts` sends `{ sessionId }`, listeners read `payload.sessionId`,
adding `route` doesn't break them. The main-window listener (in
`EventsBridge` / `use-events-subscription`) extends the existing
`onNavigateToSession` callback to also handle `route`:
```ts
onNavigateToSession((payload) => {
  if (payload.sessionId) {
    navigate({ to: '/session/$sessionId', params: { sessionId: payload.sessionId } })
  } else if (payload.route) {
    navigate({ to: payload.route as never })
  }
})
```
The preload's `onNavigateToSession` callback type changes from
`(sessionId: string) => void` to `(payload: { sessionId?: string; route?: string }) => void`.
`deep-link.ts` (the only existing sender) continues to send `{ sessionId }`
unchanged.

**Preload extension** (`apps/desktop/src/preload/index.ts`):
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

Type added to `preload/index.d.ts` `window.swarm` shape.

## File Manifest

### New files

```
apps/desktop/src/main/quick-panel/
  index.ts                        # initQuickPanel(): create window + register hotkey + wire IPC
  quick-panel-window.ts           # createQuickPanelWindow / getQuickPanelWindow / toggle / show / hide
  shortcut.ts                     # registerQuickPanelHotkey / unregister / config read-write
  ipc.ts                          # wireQuickPanelIpc: hide / resize / focusMain / getHotkey / setHotkey
  store.ts                        # quick-panel.json read-write (hotkey config)
  store.test.ts

apps/desktop/src/renderer/src/components/quick-panel/
  quick-panel.tsx                 # top-level: mode switching
  quick-panel-input.tsx           # input + slash command popover
  quick-panel-results.tsx         # palette results list
  quick-panel-chat.tsx            # chat mini-session
  use-quick-panel-state.ts        # state machine hook

apps/desktop/src/renderer/src/routes/
  quick-panel.tsx                 # /quick-panel route
```

### Modified files

| File | Change |
|------|--------|
| `main/index.ts` | Call `initQuickPanel()` in `app.whenReady`; unregister hotkey on `will-quit` |
| `preload/index.ts` | Add `quickPanel` bridge |
| `preload/index.d.ts` | Add `quickPanel` type |
| `renderer/src/routes/__root.tsx` | `RootLayout`: skip TitleBar/AppRail when route is `/quick-panel` |
| `renderer/src/components/events-bridge` / `use-events-subscription` | Listen for `swarm:navigate` `route` field → `navigate({ to })` |
| Settings dialog | New "快捷面板" section: hotkey display + rebind button |

## Testing Strategy

- **`store.test.ts`**: hotkey config read/write, default value, corrupt-file handling
- **`shortcut` logic**: mock `globalShortcut.register`, verify register/unregister/failure return values; failed registration preserves previous `currentAccelerator`
- **`use-quick-panel-state`**: pure state machine — `/` shows slash list, `/agent` + Tab → chat mode, Esc → hide trigger, palette prefixes `>` `@` `#` → scope parsing
- **`buildItems` reuse**: mock `Callbacks`, verify `navigate`/`openSettings` call `quickPanel.focusMain` not internal router navigation
- **Integration (manual)**: global hotkey → panel appears → palette search → `/agent` Tab → type prompt → streaming output → Esc hides → session visible in main window list

## Out of Scope (YAGNI)

- Agent switching UI inside the panel
- Attachment upload in the panel
- Export markdown from the panel
- Multiple slash commands beyond `/agent`
- Panel position memory (recenter on cursor's display each time)
