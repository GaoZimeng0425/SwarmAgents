# Native-Feel Polish — Design

**Date:** 2026-05-24
**Branch base:** `feat/plan-E-frontend-stack` (current)
**Status:** Spec — implementation plan pending (`writing-plans` next)
**Goal:** Refactor SwarmAgents so it passes ≥ 90% of the 75-item `docs/checklists/ship-readiness.md` audit without abandoning Electron. Apply Tenets T1–T8 from `docs/references/01-philosophy.md` to the existing four-process layout.

---

## §1 Scope & Non-Goals

**Scope (chosen path: "Option C — polish + small native IPC additions + multi-window Settings"):**

- Patch the 14 ship-readiness red items the audit found (listed in §3).
- Add 4 native-shell IPC channels (`system:getAccent`, `system:onAccentChange`, `system:showConfirm`, `system:openSettings`).
- Split Settings into its own `BrowserWindow` with a separate Vite entry point.
- Wire `electron-updater` + a `swarmagents://` URL scheme + correct bundle identifier.
- Replace the DOM permission modal for `risk: 'high'` with a native `dialog.showMessageBox`; keep `medium` as a non-blocking drawer; `low` becomes inline.

**Non-Goals:**

- No move off Electron. No native Swift/AppKit shell. No WKWebView host.
- No rewrite of `src/worker/` or `pi-agent` integration.
- No new Zod schemas in `task.ts` / `permission.ts` — only `ipc.ts` and `ui.ts` gain 4 entries.
- No new product features. This refactor changes how things *feel*, not what the app *does*.
- No multi-window beyond Settings in this iteration. AI-chat / Notes / Theme-studio windows can follow the same multi-entry pattern later if needed.

---

## §2 Tenet Compliance Map

The current codebase already aligns with several SKILL.md tenets. This spec preserves the alignments and fixes the misses.

| Tenet | Status before | Status after |
|---|---|---|
| **T1** seam at WebView | ✅ main / preload / renderer / worker already split that way | unchanged |
| **T2** one schema, many languages | ✅ Zod in `src/shared/types/*`, codegen via TS types | +4 channels, same pattern |
| **T3** adopt the platform | ⚠️ vibrancy enabled but defeated by opaque CSS; web font in use; DOM modals | ✅ transparent body, system font, native dialog for high-risk |
| **T4** perception over measurement | ⚠️ no `prefers-reduced-motion`; no font-fallback prewarm | ✅ both wired |
| **T5** short iteration loop | ✅ electron-vite HMR | unchanged |
| **T6** intentional boundaries | ✅ async invoke + single event bus | +4 channels — all sparse, no hot loops |
| **T7** muscle memory | n/a (greenfield) | preserve `⌘,` for Settings, `⌘W`, `⌘Q` defaults |
| **T8** baseline vs margin | ⚠️ baseline costs not measured | add idle-CPU & memory targets to §6 verification |

---

## §3 Audit Findings — the 14 Red Items

Source: `docs/checklists/ship-readiness.md` walked against current `main/index.ts`, `renderer/src/`, and `preload/index.ts`.

| # | Ship ID | Where it lives now | Why it fails |
|---|---|---|---|
| 1 | C.21 | `task-list-item.tsx:26` literal `cursor-pointer transition` | "Single most diagnostic" web tell. |
| 2 | D.31 | `styles/globals.css` `:root --background: oklch(1 0 0)` + `body { @apply bg-background }` | Solid backgrounds paint over the `vibrancy: 'sidebar'` material set in main. |
| 3 | D.34 | `main.tsx:1` `import '@fontsource-variable/geist'` | Web font instead of `-apple-system, Segoe UI`. |
| 4 | D.33 | `:root --primary: oklch(0.205 0 0)` hardcoded | Doesn't follow system accent. |
| 5 | C.22 | Only `<TitleBar>` uses `select-none` | Labels, button text, sidebar entries draggable as text. |
| 6 | C.23 | No `context-menu` interception in `main/index.ts` | Right-click shows "Reload / Inspect Element". |
| 7 | B.19 | `permission-sheet.tsx` uses shadcn `Sheet` with backdrop blur | "No modal overlays with backdrop blur for dialogs." |
| 8 | D.39 | No `prefers-reduced-motion` query anywhere | |
| 9 | C.24 / C.25 | preload doesn't inject `-webkit-touch-callout: none` or disable spellcheck on chrome | |
| 10 | F.49 / F.51 | `webPreferences.backgroundThrottling` not set | Hidden window throttled by WebKit/Chromium. |
| 11 | (06-conv § Windowing) | `title-bar.tsx` is a 7dp `<div>` inside `SidebarHeader` | "Real title bar, not a hand-painted div pretending." |
| 12 | G.65 | `setAppUserModelId('com.electron')` | Placeholder bundle ID. |
| 13 | G.56 / G.62 | No URL scheme; `electron-updater` installed but never invoked | |
| 14 | A.9 | No font-fallback prewarm; placeholder text already contains 中文 | First CJK glyph stutters on cold start. |

---

## §4 Architecture Delta

The four-process model is unchanged. New files are added to `src/main/system/` (peer of `permission/`, `supervisor/`) and `src/main/windows/`. No rewrites.

```
src/main/
├── system/                       # NEW
│   ├── accent.ts                 # systemPreferences accent → CSS var, with change subscription
│   ├── confirm.ts                # dialog.showMessageBox wrapper
│   ├── url-scheme.ts             # app.setAsDefaultProtocolClient + open-url routing
│   ├── auto-update.ts            # electron-updater wiring (silent install, toast notify)
│   ├── context-menu.ts           # webContents 'context-menu' interceptor
│   └── menu.ts                   # native app menu (⌘, for Settings, std edit/window)
├── windows/                      # NEW
│   ├── main-window.ts            # createWindow() extracted from index.ts
│   └── settings-window.ts        # independent BrowserWindow + 2nd Vite entry
├── ipc/swarm-ipc.ts              # MODIFIED: mounts system/* routes
├── permission/                   # UNCHANGED (logic-level)
├── supervisor/                   # UNCHANGED
└── index.ts                      # SHRINKS: only app-lifecycle orchestration

src/renderer/
├── index.html                    # main window entry (unchanged path)
├── settings.html                 # NEW
└── src/
    ├── entries/
    │   ├── main.tsx              # MOVED from src/main.tsx, providers unchanged
    │   └── settings.tsx          # NEW: minimal providers, mounts settings route tree
    ├── routes/                   # main window route tree (Tasks, Skills)
    │   └── settings.tsx          # DELETED (migrated to routes-settings/)
    ├── routes-settings/          # NEW: settings window route tree
    │   ├── __root.tsx
    │   ├── general.tsx
    │   ├── permissions.tsx
    │   └── about.tsx
    └── ...
```

**LoC budget:**

| Area | Δ lines |
|---|---|
| `src/main/system/*` | ~250 (6 files, ~40 each) |
| `src/main/windows/*` | ~120 (split + new) |
| `src/main/index.ts` | -50 (shrinks) |
| `src/shared/types/ipc.ts` + `ui.ts` | +60 (4 channels) |
| `src/preload/index.ts` | +30 (4 bridge methods + DOMContentLoaded hooks) |
| `src/renderer/src/styles/globals.css` | +40 (transparent body, system font, user-select, reduced-motion) |
| `src/renderer/src/entries/*` | ~80 (split) |
| `src/renderer/src/routes-settings/*` | ~150 (new tiny route tree) |
| `src/renderer/src/components/permission-sheet.tsx` | -20 → split into `permission-drawer.tsx` + `use-native-confirm.ts` |
| `electron.vite.config.ts` | +5 (second entry) |
| `electron-builder.yml` | +10 (`appId`, `category`, icons) |

**Total: ~+700 lines added, ~70 lines removed, ~50 lines moved.** No file is fully rewritten.

---

## §5 IPC Schema Additions

Four channels go into `src/shared/types/ipc.ts` (same Zod pattern as the existing `InboundSchema` / `OutboundSchema`). The `SwarmBridge` interface in `src/shared/types/ui.ts` gains four methods. The preload bridge in `src/preload/index.ts` exposes them via `contextBridge`.

| Channel | Direction | Payload (Zod-typed) | Use site |
|---|---|---|---|
| `system:getAccent` | invoke R→M | `() => { hex: string }` | On mount, write to `--system-accent` CSS var. |
| `system:accentChange` | event M→R | `{ hex: string }` | `useAccent()` hook subscribes once. |
| `system:showConfirm` | invoke R→M | `(ConfirmRequest) => 'grant' \| 'deny' \| 'skip'` | High-risk permission gate. |
| `system:openSettings` | invoke R→M | `() => void` | Sidebar "Settings" button click. |

**`ConfirmRequest` shape:**

```ts
type ConfirmRequest = {
  title: string
  message: string
  detail?: string
  buttons: Array<{ label: string; role: 'grant' | 'deny' | 'skip'; destructive?: boolean }>
  risk: 'low' | 'medium' | 'high'
}
```

**T6 frequency analysis** — all four are sparse:
- `getAccent`: once per window mount.
- `accentChange`: only when the user changes their OS accent (rare).
- `showConfirm`: only on `risk: 'high'` actions (sparse).
- `openSettings`: user-triggered.

No hot loops. No batching needed.

---

## §6 CSS / Chrome Strategy

Single source of truth: `src/renderer/src/styles/globals.css`. The change is: switch the *defaults* from web-style to native-style, opt back in only where content needs it.

```css
/* System font cascade — D.34 */
:root {
  font-family: -apple-system, BlinkMacSystemFont,
               'Segoe UI Variable', 'Segoe UI',
               system-ui, sans-serif;
}

/* Non-selectable chrome — C.22 */
* { user-select: none; -webkit-user-select: none; }
.user-content, .editable, input, textarea, [contenteditable] {
  user-select: text; -webkit-user-select: text;
}

/* Cursor default + no force-touch callout — C.21 / C.24 */
* { cursor: default; -webkit-touch-callout: none; }
input, textarea, [contenteditable] { cursor: text; }
[data-cursor="text"] { cursor: text; }

/* Window background transparent so vibrancy shows — D.31 */
html, body { background: transparent; }

/* Tokens: chrome transparent, content surfaces tinted over vibrancy */
:root {
  --background: transparent;
  --window-content: oklch(1 0 0 / 70%);
  --primary: var(--system-accent, oklch(0.55 0.18 264));
}
.dark {
  --background: transparent;
  --window-content: oklch(0.18 0 0 / 60%);
}

/* prefers-reduced-motion — D.39 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/* No default view transitions — D.40 */
::view-transition-old(root), ::view-transition-new(root) { animation: none; }
```

**Geist removal:** delete `@fontsource-variable/geist` import from `main.tsx` and `globals.css`; remove the package from `package.json` if nothing else needs it.

**Title bar relocation:** lift `<TitleBar />` out of `<SidebarHeader>` (in `app-sidebar.tsx`) up to `routes/__root.tsx`. The drag region becomes a `fixed inset-x-0 top-0 h-7 z-50` strip with `WebkitAppRegion: 'drag'`, full-width — not a centered handle.

**Cursor cleanup:** `task-list-item.tsx:26` drops the `cursor-pointer` Tailwind class. shadcn `components/ui/*` are not touched globally — instead a single `[data-action="true"]` selector opt-in is added for true buttons that should show a cursor (we will mark these case-by-case during implementation).

---

## §7 Main / Preload Changes

**`main/windows/main-window.ts` (extracted from current `index.ts:13-54`):**

```ts
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

const main = new BrowserWindow({
  width: 900, height: 670, show: false, autoHideMenuBar: true,
  backgroundColor: isMac ? '#00000000' : '#1b1b1f',   // mac transparent, others solid
  transparent: isMac,
  ...(isMac ? {
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
  } : {}),
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    backgroundThrottling: false,    // F.49 / F.51
    spellcheck: false,              // C.25 belt-and-braces
  },
})

if (isWin) main.setBackgroundMaterial('mica')  // Electron 30+

main.webContents.on('context-menu', (e) => e.preventDefault())  // C.23 (v1: suppress entirely)
```

**`main/system/menu.ts`** registers the macOS app menu with `Settings… ⌘,` mapped to `openSettings()` and standard `editMenu` / `windowMenu` for free keyboard navigation (ship H.66 partial).

**`preload/index.ts`** gains:
- `swarm.getAccent()`, `swarm.onAccentChange(cb)`, `swarm.showConfirm(req)`, `swarm.openSettings()`.
- DOMContentLoaded hooks: `document.body.spellcheck = false` (C.25) and the emoji/CJK font-fallback prewarm from `references/03-webview-survival.md` A.9 (item #14).

**`main/index.ts`** shrinks to: `requestSingleInstanceLock`, supervisor lifecycle, `app.whenReady` → wire system modules → `createMainWindow()` → `setupMenu()` → `setupAutoUpdate()` → `setupUrlScheme()`. The `createWindow` function body moves out.

---

## §8 Settings Window — Multi-Entry Bundling

**`electron.vite.config.ts` renderer additions:**

```ts
renderer: {
  build: {
    rollupOptions: {
      input: {
        index:    resolve('src/renderer/index.html'),
        settings: resolve('src/renderer/settings.html'),
      },
    },
  },
  plugins: [
    TanStackRouterVite({
      target: 'react', autoCodeSplitting: true,
      routesDirectory: resolve('src/renderer/src/routes'),
      generatedRouteTree: resolve('src/renderer/src/routeTree.gen.ts'),
    }),
    TanStackRouterVite({
      target: 'react', autoCodeSplitting: true,
      routesDirectory: resolve('src/renderer/src/routes-settings'),
      generatedRouteTree: resolve('src/renderer/src/routeTreeSettings.gen.ts'),
    }),
    // ...existing react / babel / tailwind plugins
  ],
}
```

**`settings.html`** is a minimal sibling of `index.html` pointing at `entries/settings.tsx`. The settings entry mounts a separate `<RouterProvider>` with the second route tree. It re-uses `QueryClientProvider` and `ThemeProvider` (no shared cache across windows in v1 — settings is read-light, this is fine).

**`main/windows/settings-window.ts`** opens the window on demand, single-instance (refocus if already open), `resizable: false`, `minimizable: false`, `parent: undefined` (independent top-level — ship B.18). Same vibrancy + transparency rules as main.

**Sidebar entry change:** the sidebar's "Settings" item changes from `<Link to="/settings">` to `<button onClick={() => window.swarm.openSettings()}>`.

---

## §9 Permission UI Migration

The existing `src/main/permission/gate.ts` logic is unchanged. Only the renderer-side surface changes:

| risk | UI in v1 | Rationale |
|---|---|---|
| `low` | inline toast via Sonner, no confirmation | ship F.55: no UI for sub-200ms operations. |
| `medium` | `<PermissionDrawer>` — shadcn `Drawer side="bottom"` with **no backdrop blur, no dark overlay**, dismissible by Escape | non-blocking, mimics macOS sheet. |
| `high` | `system:showConfirm` → native `dialog.showMessageBox` with `type: 'warning'` and `destructive` button for `deny` | T3 + ship B.19: blocking system-level confirmation. |

The `gate.ts` already exposes risk. The new `useNativeConfirm()` hook is the dispatcher; the existing `permission-sheet.tsx` is split:

- `permission-drawer.tsx` — what the file becomes (medium tier), losing the backdrop.
- `use-native-confirm.ts` — thin wrapper around `window.swarm.showConfirm`.
- Dispatch is in `events-bridge.tsx` (already the central renderer-side event sink).

---

## §10 System Integration

**Bundle identifier (`electron-builder.yml`):**

```yaml
appId: dev.swarmagents.app
productName: SwarmAgents
mac:
  category: public.app-category.productivity
  icon: resources/icon.icns
win:
  icon: resources/icon.ico
```

`main/index.ts` line 72 changes from `setAppUserModelId('com.electron')` to `setAppUserModelId('dev.swarmagents.app')`.

**URL scheme** (`main/system/url-scheme.ts`): registers `swarmagents://` via `app.setAsDefaultProtocolClient('swarmagents')`. macOS handles `open-url`; Windows routes via `second-instance` argv parsing.

**Auto-update** (`main/system/auto-update.ts`): `autoUpdater.autoDownload = true`, checks every 4 h, downloads silently, notifies the renderer via a single `update-ready` toast (no "click to download" link — ship G.62 anti-pattern).

**Native context menu in v1.1 (deferred):** the v1 implementation in `system/context-menu.ts` only suppresses WebKit's menu (`e.preventDefault()`). v1.1 will populate a native `Menu` with `copy / paste / select all` only when `params.isEditable === true`. This deferment is intentional and noted here so it doesn't leak into the implementation plan.

---

## §11 Cross-Platform Branches

The seam between platforms in this spec is small and named:

| Behavior | macOS | Windows | Linux |
|---|---|---|---|
| Window background | `transparent: true` + `vibrancy: 'sidebar'` | `transparent: false` + `setBackgroundMaterial('mica')` | solid `#1b1b1f` |
| Title bar | `titleBarStyle: 'hiddenInset'` (system traffic lights) | default chrome (no custom drag region needed) | default chrome |
| Settings hotkey | `⌘,` via app menu | `Ctrl+,` via app menu | `Ctrl+,` via app menu |
| Accent source | `systemPreferences.getAccentColor()` (mac native) | `systemPreferences.getAccentColor()` (win UISettings) | fallback OKLCH |
| URL scheme | `app.on('open-url')` | argv parse in `second-instance` | (skipped) |
| Auto-update channel | latest-mac.yml | latest.yml | latest-linux.yml |

Each branch lives in one named `if (process.platform === ...)` per module. No abstraction layer.

---

## §12 Verification

**Automated (CI):**

1. **`scripts/check-native-feel.ts`** runs in `pnpm verify`. Greps `src/renderer/src/` for:
   - `cursor-pointer` outside `components/ui/*` → fail.
   - `behavior: ['"]smooth` anywhere → fail.
   - Hardcoded `#[0-9a-f]{6}` in CSS where a token should be → warn.
   - `font-family:` referencing names outside the system whitelist → fail.
2. **Vitest:**
   - `main/system/*.test.ts` — mock `systemPreferences`, `dialog`, `app`, `BrowserWindow`. Cover happy path + the platform branches in §11.
   - `shared/types/ipc.test.ts` — round-trip Zod encode/decode for each of the 4 new channels.
   - Existing `supervisor/*`, `permission/*`, `worker/*` tests unchanged and must remain green.

**Manual (every release):**

- Walk all 75 items of `docs/checklists/ship-readiness.md`. Target: **≥ 65 green**. Reds allowed only in §H (accessibility) and §I (cross-platform parity).
- 30-second skeptical-user test from §125 of `06-native-conventions.md`: hand the build to someone who uses Mac/Win apps daily, watch for the first "this feels weird" moment. That item is the next bug.
- Activity Monitor (Mac): resident ≤ 500 MB at idle (ship F.46), background CPU < 0.5% with window hidden (F.49).
- Windows 11: verify mica renders + accent follows.

**Regression guardrail:** any PR that touches `renderer/src/styles/`, `renderer/src/components/ui/`, `main/windows/`, `main/system/`, or `preload/` must check off a 10-item subset of ship-readiness in the PR template.

---

## §13 Sequencing & Risk

The work splits into 5 independent stripes. Each is shippable in isolation; later stripes layer on earlier ones for cumulative effect, but no stripe blocks another from starting.

| Stripe | Scope | LoC | Risk |
|---|---|---|---|
| 1. CSS / chrome | §6 — globals.css, preload injects, title bar relocation, cursor cleanup | ~150 | Low. Reversible in one revert. Visible immediately. |
| 2. Native dialogs | §9 — `system:showConfirm`, permission gate UI tiering | ~200 | Medium. Native dialog test coverage matters (mocked). |
| 3. System accent | §5 — accent IPC + `useAccent()` hook + CSS var pipeline | ~120 | Low. |
| 4. Settings window | §8 — second Vite entry, settings route tree, `openSettings` IPC | ~250 | Medium. Build pipeline touched; smoke test required on both platforms. |
| 5. System integration | §10 — bundle ID, URL scheme, auto-update, app menu | ~180 | Medium. Auto-update needs a staging release-server to test end-to-end; staged out. |

**Recommended order:** Stripe 1 → 3 → 2 → 5 → 4. Stripe 4 last because it touches the build pipeline and benefits from the rest of the polish being settled.

**Top three risks:**

1. **`transparent: true` on Windows 10** — mica needs Win 11. Mitigation: §11 platform branch already falls back to solid background on Win 10 / Linux.
2. **`setBackgroundMaterial` API** — added in Electron 30; current deps show Electron 42, so OK. Lock the floor in `package.json` engines if not already.
3. **TanStack Router second instance** — two route trees in one renderer build is non-standard for the plugin. Mitigation: the plugin supports multiple invocations with distinct `routesDirectory` / `generatedRouteTree` paths; verified during implementation, fallback is to omit the router plugin for `settings.html` and use a hand-written `<Route>` switch (tiny — 4 routes).

---

## §14 Out of Scope (Explicit Deferrals)

- **AI-chat / Notes / Theme-studio multi-window** — same multi-entry pattern, but adds product surface area; defer to later when those features ship.
- **Rust core (Layer 4 from `02-architecture.md`)** — current pi-agent worker is pure TS. No CPU-bound path needs Rust yet. Revisit when a real performance budget is missed.
- **Native popovers via NSPopover IPC** — `03-webview-survival.md § A.7` is the future fix; current shadcn popovers stay DOM in v1.
- **Sentry / crash reporting** — ship G.63. Add when there's a Sentry account configured.
- **Full WCAG AA audit** — ship H.68. Lint sweep + manual VoiceOver pass deferred to v1.1.
