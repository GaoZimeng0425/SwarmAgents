# Chrome MV3 Extension Skeleton (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Chrome MV3 extension under `apps/extension/` using **WXT** that connects to the running desktop's WebSocket host and can probe it (`listAgents`) — the first real external consumer of `@swarm/protocol` over WS.

**Architecture:** WXT (Vite-based MV3 framework) owns entrypoints and auto-generates the manifest. The background service worker owns a `ServiceClient` over a thin browser-WebSocket→`ServiceTransport` adapter, kept alive by a `browser.alarms` heartbeat with reconnect-on-disconnect. The popup is a tiny React UI (connection probe); the options page stores `{ wsHost, token }` in `browser.storage.local`. `@swarm/protocol` is consumed via a vite alias (WXT exposes `vite` in its config) to `packages/protocol/src` — no protocol build step.

**Tech Stack:** WXT, `@wxt-dev/module-react`, React 19, `@swarm/protocol` (workspace), `browser.storage.local`/`browser.alarms` (WXT auto-imported), vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-multiplatform-structure-design.md` (§6.2 extension/, §7.1 client-side transport, §9 MV3 idle/GC, §10 Phase 5).

## Global Constraints

- **Language:** Code comments and commit messages in English. Conversation in Chinese.
- **Framework:** WXT (manifest auto-generated from entrypoints + `wxt.config.ts`). Entrypoints live under `apps/extension/entrypoints/` (WXT convention).
- **Protocol consumption:** WXT's `vite.resolve.alias` maps `@swarm/protocol` → `../../packages/protocol/src` (rollup bundles from source; no `@swarm/protocol` build/dist step).
- **Browser API:** WXT auto-imports `browser` (webextension-polyfill). Use `browser.storage` / `browser.alarms` / `browser.runtime` — NOT the raw `chrome` global.
- **Storage:** `browser.storage.local` for `{ wsHost, token }` (set in options, read in background).
- **Loopback:** default `wsHost` = `ws://127.0.0.1:47777` (the desktop host's fixed port). The token is the 64-hex string from the desktop's `userData/ws-host.json`.
- **Tests:** plain `vitest run` for the WS transport unit test (the extension package has no Electron/native deps). The end-to-end (load unpacked + connect to a running desktop) is a manual smoke step.
- **Scope of v1:** connection probe only. `submitGoal` needs a `ProviderInjection` the extension doesn't own — deferred until provider config is exposed over WS.
- **Worktree:** Execute in `worktree-chrome-extension`. One commit per task.

---

## File Structure

**Create `apps/extension/`:**
- `package.json` — `@swarm/extension`; deps `@swarm/protocol`, `react`, `react-dom`; devDeps `wxt`, `@wxt-dev/module-react`, `typescript`, `@types/react`, `@types/react-dom`, `vitest`.
- `wxt.config.ts` — react module + manifest (permissions, host_permissions) + `@swarm/protocol` vite alias.
- `tsconfig.json` — extends `./.wxt/tsconfig.json` (WXT-generated).
- `entrypoints/background.ts` — `defineBackground`: load config, build `ServiceClient`, heartbeat/reconnect, message handler.
- `entrypoints/popup/{index.html, main.tsx, Popup.tsx}` — connection probe UI.
- `entrypoints/options/{index.html, main.tsx, Options.tsx}` — wsHost + token form.
- `lib/transport-ws.ts` (+ test) — browser `WebSocket` → `ServiceTransport` (shared, not an entrypoint).

---

## Task 1: WXT scaffolding + build

**Files:**
- Create: `apps/extension/{package.json, wxt.config.ts, tsconfig.json}`, `apps/extension/entrypoints/background.ts`, `apps/extension/entrypoints/popup/{index.html, main.tsx}`, `apps/extension/entrypoints/options/{index.html, main.tsx}` (placeholders).
- Test: `pnpm --filter @swarm/extension run build` produces `apps/extension/.output/`.

**Interfaces:**
- Produces: a buildable WXT MV3 skeleton.

- [ ] **Step 1: package.json**

`apps/extension/package.json`:
```json
{
  "name": "@swarm/extension",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "wxt build",
    "dev": "wxt",
    "test": "vitest run",
    "postinstall": "wxt prepare"
  },
  "dependencies": {
    "@swarm/protocol": "workspace:*",
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@wxt-dev/module-react": "latest",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9",
    "wxt": "latest"
  }
}
```

- [ ] **Step 2: wxt.config.ts**

`apps/extension/wxt.config.ts`:
```typescript
import { resolve } from 'node:path'
import { defineConfig } from 'wxt'

// WXT auto-generates manifest.json from entrypoints + the manifest block below.
// @swarm/protocol is bundled from source via the vite alias (no package build).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SwarmAgents',
    version: '0.1.0',
    description: 'Quick launcher for the SwarmAgents desktop runtime.',
    permissions: ['storage', 'alarms'],
    host_permissions: ['ws://127.0.0.1:47777/*', 'http://127.0.0.1:47777/*'],
  },
  vite: {
    resolve: {
      alias: {
        '@swarm/protocol': resolve(__dirname, '../../packages/protocol/src'),
      },
    },
  },
})
```

- [ ] **Step 3: tsconfig.json**

`apps/extension/tsconfig.json`:
```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "paths": {
      "@swarm/protocol": ["../../packages/protocol/src"],
      "@swarm/protocol/*": ["../../packages/protocol/src/*"]
    }
  },
  "include": ["entrypoints/**/*", "lib/**/*", "wxt.config.ts"]
}
```
(The `.wxt/tsconfig.json` is generated by `wxt prepare` in postinstall — it provides WXT's auto-import types including the `browser` global and `defineBackground`.)

- [ ] **Step 4: Placeholder entrypoints**

`apps/extension/entrypoints/background.ts`:
```typescript
export default defineBackground(() => {
  console.log('[swarm-ext] background boot')
})
```

`apps/extension/entrypoints/popup/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>SwarmAgents</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```
`apps/extension/entrypoints/popup/main.tsx`:
```typescript
console.log('[swarm-ext] popup boot')
```

`apps/extension/entrypoints/options/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>SwarmAgents Options</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
```
`apps/extension/entrypoints/options/main.tsx`:
```typescript
console.log('[swarm-ext] options boot')
```

- [ ] **Step 5: Install + prepare + build**

```bash
pnpm install
pnpm --filter @swarm/extension run build
```
Expected: `wxt prepare` generates `.wxt/`; `wxt build` emits `apps/extension/.output/chrome-mv3/` containing `manifest.json`, `background.js`, `popup.html`, `options.html`. If the install warns about missing `webextension-polyfill` types, that's normal — WXT provides the `browser` types via `.wxt/tsconfig.json`.

- [ ] **Step 6: Commit**

```bash
git add apps/extension/ pnpm-lock.yaml
git commit -m "build(extension): WXT + React scaffolding for @swarm/extension"
```

---

## Task 2: WS transport + background ServiceClient (TDD)

**Files:**
- Create: `apps/extension/lib/transport-ws.ts`, `apps/extension/lib/transport-ws.test.ts`
- Modify: `apps/extension/entrypoints/background.ts` (boot a `ServiceClient` from stored config).
- Test: `transport-ws.test.ts`.

**Interfaces:**
- Produces: `createWsTransport(ws: WebSocket): { transport: ServiceTransport; ready: Promise<void>; close(): void }` — adapts a browser `WebSocket` to `@swarm/protocol`'s `ServiceTransport`.

- [ ] **Step 1: Write the failing test**

`apps/extension/lib/transport-ws.test.ts`:
```typescript
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createWsTransport } from './transport-ws'

// Minimal fake of the browser WebSocket interface the adapter calls into.
class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  readyState = 0
  constructor(public url: string, public subprotocol: string) {
    super()
    queueMicrotask(() => { this.readyState = 1; this.emit('open') })
  }
  send(data: string) { this.emit('__sent', data) }
  close() { this.readyState = 3; this.emit('close') }
}

describe('createWsTransport', () => {
  it('resolves ready on open, then relays parsed messages to listeners', async () => {
    const ws = new FakeWebSocket('ws://x', 'swarm.tok')
    const { transport, ready } = createWsTransport(ws as unknown as WebSocket)
    await ready

    const received: unknown[] = []
    transport.on('message', (m) => received.push(m))
    ws.emit('message', { data: JSON.stringify({ kind: 'response', id: 1, ok: true, result: { ok: 1 } }) })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'response', id: 1 })
  })

  it('postMessage stringifies and sends over the socket', async () => {
    const ws = new FakeWebSocket('ws://x', 'swarm.tok')
    const { transport, ready } = createWsTransport(ws as unknown as WebSocket)
    await ready
    const sent: string[] = []
    ws.on('__sent', (d: string) => sent.push(d))
    transport.postMessage({ kind: 'request', id: 9, method: 'listAgents', args: [] })
    expect(sent).toEqual([JSON.stringify({ kind: 'request', id: 9, method: 'listAgents', args: [] })])
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './transport-ws'`).

```bash
pnpm --filter @swarm/extension run test -- lib/transport-ws.test.ts
```

- [ ] **Step 3: Implement**

`apps/extension/lib/transport-ws.ts`:
```typescript
import type { ServiceTransport } from '@swarm/protocol'

// Adapt a browser WebSocket to @swarm/protocol's ServiceTransport.
// addEventListener('message') delivers MessageEvent<string>; we parse and
// forward. postMessage stringifies. `ready` resolves on the socket's open.
export function createWsTransport(ws: WebSocket): {
  transport: ServiceTransport
  ready: Promise<void>
  close: () => void
} {
  const listeners = new Set<(m: unknown) => void>()

  const onMessage = (ev: MessageEvent): void => {
    try {
      const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      listeners.forEach((fn) => fn(parsed))
    } catch {
      /* drop malformed frames */
    }
  }
  ws.addEventListener('message', onMessage as EventListener)

  const ready = new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.OPEN) resolve()
    else ws.addEventListener('open', () => resolve(), { once: true })
  })

  const transport: ServiceTransport = {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (_channel: 'message', fn: (m: unknown) => void) => listeners.add(fn),
    off: (_channel: 'message', fn: (m: unknown) => void) => listeners.delete(fn),
  }

  return { transport, ready, close: () => ws.close() }
}
```

- [ ] **Step 4: Run — expect PASS** (2 tests).

- [ ] **Step 5: Background boot — read config, build ServiceClient**

`apps/extension/entrypoints/background.ts`:
```typescript
import { createServiceClient, type ServiceClient } from '@swarm/protocol'
import { createWsTransport } from '../lib/transport-ws'

type HostConfig = { wsHost: string; token: string }

async function loadConfig(): Promise<HostConfig> {
  const { wsHost, token } = await browser.storage.local.get(['wsHost', 'token'])
  return {
    wsHost: (wsHost as string) || 'ws://127.0.0.1:47777',
    token: (token as string) || '',
  }
}

let client: ServiceClient | null = null

async function connect(): Promise<void> {
  const { wsHost, token } = await loadConfig()
  if (!token) {
    console.warn('[swarm-ext] no token configured — set it in Options')
    return
  }
  const ws = new WebSocket(wsHost, `swarm.${token}`)
  const { transport, ready } = createWsTransport(ws)
  await ready
  client = createServiceClient({
    transport,
    onEvent: (event, data) => console.log('[swarm-ext] event', event, data),
  })
  await client.connect()
  console.log('[swarm-ext] connected to', wsHost)
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => { void connect() })
  browser.runtime.onStartup.addListener(() => { void connect() })
})
```

- [ ] **Step 6: Build + commit**

```bash
pnpm --filter @swarm/extension run build
git add apps/extension/
git commit -m "feat(extension): WS transport + background ServiceClient boot"
```

---

## Task 3: Heartbeat + reconnect + options page

**Files:**
- Create: `apps/extension/entrypoints/options/{main.tsx, Options.tsx}`
- Modify: `apps/extension/entrypoints/background.ts` (heartbeat via `browser.alarms` + reconnect + message handler + storage-change reconnect).
- Test: build + manual options render.

**Interfaces:**
- Produces: a reconnecting background SW; an options page persisting `{wsHost, token}` that triggers a reconnect.

- [ ] **Step 1: Background heartbeat + reconnect + message handler**

Replace `apps/extension/entrypoints/background.ts`:
```typescript
import { createServiceClient, type ServiceClient } from '@swarm/protocol'
import { createWsTransport } from '../lib/transport-ws'

type HostConfig = { wsHost: string; token: string }

async function loadConfig(): Promise<HostConfig> {
  const { wsHost, token } = await browser.storage.local.get(['wsHost', 'token'])
  return {
    wsHost: (wsHost as string) || 'ws://127.0.0.1:47777',
    token: (token as string) || '',
  }
}

let client: ServiceClient | null = null
let activeWs: WebSocket | null = null

async function connect(): Promise<void> {
  const { wsHost, token } = await loadConfig()
  if (!token) {
    console.warn('[swarm-ext] no token — set it in Options')
    return
  }
  if (activeWs) {
    try { activeWs.close() } catch { /* noop */ }
  }
  const ws = new WebSocket(wsHost, `swarm.${token}`)
  activeWs = ws
  ws.addEventListener('close', () => {
    console.warn('[swarm-ext] ws closed — will retry on next alarm')
    client = null
    activeWs = null
  })
  const { transport, ready } = createWsTransport(ws)
  await ready
  client = createServiceClient({
    transport,
    onEvent: (e, d) => console.log('[swarm-ext] event', e, d),
  })
  await client.connect()
  console.log('[swarm-ext] connected to', wsHost)
}

export default defineBackground(() => {
  // MV3 service workers are killed after ~30s idle. A periodic alarm both
  // wakes the worker and drives reconnect attempts when the WS has dropped.
  browser.alarms.create('swarm-keepalive', { periodInMinutes: 0.5 })
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'swarm-keepalive' && !activeWs) void connect()
  })

  browser.runtime.onInstalled.addListener(() => { void connect() })
  browser.runtime.onStartup.addListener(() => { void connect() })
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.wsHost || changes.token)) void connect()
  })

  // popup probes connectivity by listing agents (no provider/secret needed —
  // submitGoal needs a ProviderInjection the extension doesn't own; deferred).
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if ((msg as { type?: string })?.type === 'listAgents' && client) {
      ;(async () => {
        try {
          const agents = await client.listAgents()
          sendResponse({ ok: true, count: agents.length })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // async response
    }
    return false
  })
})
```

- [ ] **Step 2: Options page**

`apps/extension/entrypoints/options/Options.tsx`:
```typescript
import { useEffect, useState } from 'react'

export function Options(): JSX.Element {
  const [wsHost, setWsHost] = useState('ws://127.0.0.1:47777')
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    browser.storage.local.get(['wsHost', 'token']).then((v) => {
      if (v.wsHost) setWsHost(v.wsHost as string)
      if (v.token) setToken(v.token as string)
    })
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 480 }}>
      <h2>SwarmAgents</h2>
      <p style={{ color: '#666', fontSize: 13 }}>
        Copy the token from the desktop's <code>userData/ws-host.json</code>.
      </p>
      <label>WS host</label>
      <input value={wsHost} onChange={(e) => setWsHost(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <label>Token</label>
      <input value={token} onChange={(e) => setToken(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <button
        onClick={() => {
          browser.storage.local.set({ wsHost, token }).then(() => setSaved(true))
        }}
      >
        Save
      </button>
      {saved && <span style={{ color: 'green', marginLeft: 8 }}>saved — background will reconnect</span>}
    </div>
  )
}
```
`apps/extension/entrypoints/options/main.tsx`:
```typescript
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Options } from './Options'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Options /></React.StrictMode>
)
```

- [ ] **Step 3: Build + commit**

```bash
pnpm --filter @swarm/extension run build
git add apps/extension/
git commit -m "feat(extension): alarms keepalive + reconnect + options page"
```

---

## Task 4: Popup (connection probe) + end-to-end smoke

**Files:**
- Create: `apps/extension/entrypoints/popup/{main.tsx, Popup.tsx}`
- Test: manual load-unpacked smoke against a running desktop.

**Interfaces:**
- Produces: a popup that probes the connection (`listAgents` via background message) and shows the agent count.

- [ ] **Step 1: Popup**

`apps/extension/entrypoints/popup/Popup.tsx`:
```typescript
import { useState } from 'react'

type ProbeResult = { ok: true; count: number } | { ok: false; error: string }

export function Popup(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [busy, setBusy] = useState(false)

  const probe = (): void => {
    setBusy(true)
    setResult(null)
    browser.runtime.sendMessage({ type: 'listAgents' }, (r: ProbeResult) => {
      setResult(r)
      setBusy(false)
    })
  }

  return (
    <div style={{ fontFamily: 'system-ui', width: 320, padding: 12 }}>
      <h3 style={{ margin: '0 0 8px' }}>SwarmAgents</h3>
      <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px' }}>
        Skeleton — verifies the extension can reach the desktop runtime over WS.
      </p>
      <button disabled={busy} onClick={probe} style={{ width: '100%' }}>
        {busy ? '…' : 'test connection'}
      </button>
      {result?.ok && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
          connected — {result.count} agents visible on the desktop.
        </div>
      )}
      {result && !result.ok && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#c00' }}>error: {result.error}</div>
      )}
      <div style={{ marginTop: 8 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); browser.runtime.openOptionsPage() }}>
          options
        </a>
      </div>
    </div>
  )
}
```
`apps/extension/entrypoints/popup/main.tsx`:
```typescript
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Popup } from './Popup'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Popup /></React.StrictMode>
)
```

- [ ] **Step 2: Build**

```bash
pnpm --filter @swarm/extension run build
```
Expected: `.output/chrome-mv3/{manifest.json, background.js, popup.html, options.html}` rebuilt.

- [ ] **Step 3: End-to-end smoke (manual)**

Prerequisites: the desktop app must be running (it owns the WS host). In a terminal:
```bash
cd <main repo>; pnpm dev   # desktop app — keep it running
```
In another terminal, read the host config:
```bash
cat ~/Library/Application\ Support/SwarmAgents/ws-host.json
```
Load the extension: Chrome → `chrome://extensions` → enable Developer mode → "Load unpacked" → select `apps/extension/.output/chrome-mv3`. Open the extension Options, paste the token from `ws-host.json`, Save. Open the extension popup, click "test connection". Expected: popup prints "connected — N agents visible"; that N matches the desktop's configured agents.

- [ ] **Step 4: Commit**

```bash
git add apps/extension/entrypoints/popup/
git commit -m "feat(extension): popup connection probe + end-to-end smoke"
```

---

## Acceptance

Plan 4 is complete when **all** hold:

1. `apps/extension/` builds via `pnpm --filter @swarm/extension run build` → `.output/chrome-mv3/{manifest.json, background.js, popup.html, options.html}`.
2. `@swarm/protocol` is bundled from source (WXT vite alias) — no protocol build step.
3. `transport-ws.test.ts` passes (adapter relays both ways).
4. Chrome loads `.output/chrome-mv3/` as an unpacked MV3 extension without errors.
5. Options page persists `{wsHost, token}` and triggers a background reconnect.
6. With the desktop running, the popup's "test connection" returns the agent count from the desktop's service.
7. `node tools/check-boundaries.mjs` still passes.

After Plan 4 lands, proceed to Plan 5 (Expo React Native skeleton, Phase 6) — the mobile consumer.
