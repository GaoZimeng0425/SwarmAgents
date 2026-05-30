---
name: run-desktop
description: Build, run, and drive the SwarmAgents Electron desktop app. Use when asked to launch the app, take a screenshot of it, build it, open the Settings window, or interact with its UI.
---

SwarmAgents is an Electron app (electron-vite + React + TanStack Router). On
**macOS** drive it directly with the Playwright `_electron` REPL at
`.claude/skills/run-desktop/driver.mjs` — no xvfb needed. `playwright-core` is a
devDependency; the driver resolves it from the project `node_modules`.

All paths are relative to the repo root.

## Build FIRST (load-bearing)

The driver launches the **built** app (`out/main/index.js`, per `package.json`
`main`). Source edits are invisible until you rebuild:

```bash
pnpm exec electron-vite build      # ~1-2s; writes out/
```

If you skip this, you'll screenshot stale UI and think your change didn't work.

## Run (agent path)

```bash
tmux new-session -d -s app -x 220 -y 50
tmux send-keys -t app 'cd /Users/gaozimeng/Learn/macOS/SwarmAgents && node .claude/skills/run-desktop/driver.mjs' Enter
timeout 20 bash -c 'until tmux capture-pane -t app -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t app 'launch' Enter
timeout 70 bash -c 'until tmux capture-pane -t app -p | grep -q "^launched"; do sleep 0.3; done'
tmux send-keys -t app 'settings /permissions' Enter   # open Settings window at a route
tmux send-keys -t app 'ss settings-permissions' Enter
tmux capture-pane -t app -p
```

Then open `/tmp/shots/settings-permissions.png` and **look at it**. A blank/black
frame means launch or capture failed.

For a one-shot screenshot you can also pipe commands without tmux:

```bash
printf 'launch\nsettings /permissions\nss settings-permissions\nquit\n' \
  | node .claude/skills/run-desktop/driver.mjs
```

Screenshots land in `/tmp/shots/` (override: `SCREENSHOT_DIR`).

## Commands

| command | what it does |
|---|---|
| `launch` | launch the app, focus the main window |
| `settings [route]` | open the **separate** Settings window at a hash route (default `/permissions`) and switch focus to it |
| `use [url-substr]` | switch focus between windows (`index.html` = main, `settings.html` = settings) |
| `goto <hash>` | navigate the current window's hash router (`/skills`, `/providers`, …) |
| `ss [name]` | screenshot current window → `/tmp/shots/<name>.png` (injects a solid backdrop — see Gotchas) |
| `click <css>` / `click-text <text>` | click via DOM (not coords) |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css>` | wait for selector (10s) |
| `text [css]` / `eval <js>` | read innerText / evaluate in page |
| `windows` | list all open window URLs |
| `quit` | close app, exit |

### Routes
- **Main window** (`index.html`): `/` (chat/tasks), `/skills`
- **Settings window** (`settings.html`): `/` (General), `/providers`, `/permissions`, `/about`. Opened via `window.swarm.openSettings({ initialRoute })`, NOT a route inside the main window.

## Run (human path)

```bash
pnpm dev      # opens real windows with native vibrancy; Ctrl-C to quit
```

## Gotchas

- **Settings is its own BrowserWindow**, reached via the `openSettings` IPC, not a
  route in the main window. Use the `settings` command; don't try `goto /permissions`
  on the main window.
- **Transparent vibrancy → see-through screenshots.** The body is transparent so the
  OS material shows through. A web-contents screenshot can't capture native blur, so
  `ss` injects a solid backdrop (`#1d1d1f` dark / `#ececec` light) before capturing.
  The real window looks better than the screenshot.
- **macOS permission status reflects the launcher in dev.** Settings → Permissions
  reads live TCC status; under the dev launcher it shows whatever that process was
  granted, not the eventual packaged `SwarmAgents.app`.
- **`--no-sandbox`** is passed because the unsigned dev Electron can't use the sandbox.

## Troubleshooting

- **Launch timeout:** `out/main/index.js` missing → run the build step.
- **`Cannot find package 'playwright-core'`:** run the driver from inside the repo
  (cwd under the project) so ESM resolves the project `node_modules`; reinstall with
  `pnpm add -D playwright-core` if absent.
- **Stale UI in screenshot:** you forgot to rebuild after editing source.
- **safeStorage / Keychain errors at startup:** the app needs the macOS Keychain to
  start; unlock it or run on a real login session.
