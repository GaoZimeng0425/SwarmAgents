# Web Chat App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/web` — a Vite + React SPA that connects to the existing desktop Electron WS host as a third WS peer, enabling session browsing, prompt sending, streaming replies, and permission approval entirely in the browser.

**Architecture:** The desktop app already runs a WS host (`apps/desktop/src/main/host/`) on `0.0.0.0` with token-via-`Sec-WebSocket-Protocol` auth and supports multiple peers. The web app is architecturally a peer of the mobile app: it reuses `@swarm/protocol` (`ServiceClient` / `ServiceTransport` / `createServiceClient`), `@swarm/shared` (`MessageEventSource` / `useMessages` / `hydrateSession` / `useMessageEventSubscription` / `buildSegments` — the transport-agnostic message-rendering layer the mobile app already consumes), and `@swarm/ui` (shadcn / Tailwind v4 components). A browser-WebSocket transport adapter (mirroring the mobile/extension one) adapts the native `WebSocket` into a `ServiceTransport`. RPC state is managed via TanStack Query (catalog-pinned). No desktop-side changes.

**Tech Stack:** Vite + React 19 + TypeScript, `@swarm/protocol` (workspace:*), `@swarm/shared` (workspace:*), `@swarm/ui` (workspace:*), `@tanstack/react-query` (catalog), `react-router-dom`, `@tailwindcss/vite` (catalog).

## Global Constraints

- Package manager is **pnpm** (workspace monorepo). Use `pnpm` for all install/add commands.
- Code comments and commit messages must be in **English**.
- Conversation replies must be in **Chinese**.
- `@swarm/protocol` and `@swarm/shared` are logger-free (no pino). Use `console` in web app code.
- The WS token is a secret — never log it, never put it in a URL query string. It travels only as a `Sec-WebSocket-Protocol` subprotocol (`swarm.<token>`), matching the host's auth check in `ws-server.ts`.
- Path alias is `@` → `./src` (configured in `vite.config.ts` and `tsconfig.json`).
- `tools/check-boundaries.mjs` only governs `packages/*` (not `apps/*`), so the web app may freely import React/web libraries. But do NOT import across `apps/*` packages (e.g. don't import from `@swarm/extension` or `@swarm/desktop`) — copy the small transport adapter instead.
- Biome formatting (`pnpm format` / `pnpm check` from the repo root) applies to the new package.
- The new package must register in `pnpm-workspace.yaml` implicitly (it's under `apps/*`).
- `@tanstack/react-query` is added to `pnpm-workspace.yaml` `catalog:` so the web app and desktop renderer share one pinned version.

---

## File Structure

### All new files (under `apps/web/`)

| File | Responsibility |
|---|---|
| `apps/web/package.json` | Deps: `@swarm/protocol`, `@swarm/shared`, `@swarm/ui` (workspace:*), `@tanstack/react-query` + `react` + `react-dom` + `react-router-dom` (catalog or version), devDeps: `vite`, `@vitejs/plugin-react`, `typescript`, `@tailwindcss/vite`, `tailwindcss` (catalog), `vitest` (catalog) |
| `apps/web/tsconfig.json` | TS config with `@` → `./src` path alias |
| `apps/web/vite.config.ts` | Vite + React plugin + Tailwind v4 + `@` alias; vitest config block |
| `apps/web/index.html` | Vite entry HTML |
| `apps/web/src/main.tsx` | Mount React: `QueryClientProvider` → `ConnectionProvider` → `EventsBridge` → `App` |
| `apps/web/src/global.css` | Tailwind v4 import + `@swarm/ui` theme tokens |
| `apps/web/src/App.tsx` | `react-router-dom` routes: `/connect` `/sessions` `/session/:id` `/settings`; guard redirect when not connected |
| `apps/web/src/lib/transport-ws.ts` | `createWsTransport(config, onClose?)` — browser `WebSocket` → `ServiceTransport` (mirrors mobile's adapter) |
| `apps/web/src/lib/parse-config.ts` | `parseConnectionConfig(host, port, token)` — validate + assemble `ConnectionConfig` |
| `apps/web/src/stores/connection-store.tsx` | `ConnectionProvider` + `useConnection()` + module-level `eventEmitter` (isomorphic to mobile) |
| `apps/web/src/hooks/use-message-event-source.ts` | `useMessageEventSource()` — adapt `ServiceClient` + `eventEmitter` into `@swarm/shared`'s `MessageEventSource` |
| `apps/web/src/components/events-bridge.tsx` | `EventsBridge` — calls `useMessageEventSubscription(source)` once at root |
| `apps/web/src/components/segment-view.tsx` | Render one `Segment` (user/assistant/reasoning/tool/error/event) as DOM |
| `apps/web/src/components/permission-card.tsx` | Permission approval card (grant / deny buttons) |
| `apps/web/src/pages/connect.tsx` | Connection form: host/port/token inputs → `connect()` |
| `apps/web/src/pages/sessions.tsx` | Session list (TanStack Query `useQuery` over `client.listSessions()`) + settings link |
| `apps/web/src/pages/session.tsx` | Session detail: hydrate history + `useMessages()` + `buildSegments` + input bar + permission cards |
| `apps/web/src/pages/settings.tsx` | Connection status / disconnect / reconnect |
| `apps/web/src/lib/__tests__/parse-config.test.ts` | Unit tests for `parseConnectionConfig` |
| `apps/web/src/lib/__tests__/transport-ws.test.ts` | Unit tests for `createWsTransport` (Mock WebSocket) |
| `apps/web/src/stores/__tests__/connection-store.test.ts` | Unit tests for `eventEmitter` |

### Root modification

| File | Responsibility |
|---|---|
| `pnpm-workspace.yaml` (modify) | Add `@tanstack/react-query` to `catalog:` |

---

## Task 1: Scaffold `apps/web` + Catalog TanStack Query

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/global.css`
- Create: `apps/web/src/App.tsx`
- Modify: `pnpm-workspace.yaml` (add `@tanstack/react-query` to catalog)

**Interfaces:**
- Produces: a runnable Vite dev server (`pnpm --filter @swarm/web dev`) that renders a placeholder page, with `@swarm/protocol`, `@swarm/shared`, `@swarm/ui` resolvable, the `@` → `./src` alias working, and TanStack Query available.

- [ ] **Step 1: Add `@tanstack/react-query` to the catalog**

In `pnpm-workspace.yaml`, add to the `catalog:` block (after the existing `tailwindcss`-adjacent entries, keeping alphabetical-ish order). Insert this line among the catalog keys:

```yaml
  '@tanstack/react-query': ^5.62.0
```

- [ ] **Step 2: Create `apps/web/package.json`**

```json
{
  "name": "@swarm/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@swarm/protocol": "workspace:*",
    "@swarm/shared": "workspace:*",
    "@swarm/ui": "workspace:*",
    "@tanstack/react-query": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "catalog:",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "catalog:",
    "typescript": "catalog:",
    "vite": "^6.0.0",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 3: Create `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/web/vite.config.ts`**

```ts
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Create `apps/web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Swarm Agents</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `apps/web/src/global.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 7: Create `apps/web/src/App.tsx` (placeholder)**

```tsx
export default function App(): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-lg">Swarm Agents Web — scaffold OK</p>
    </div>
  )
}
```

- [ ] **Step 8: Create `apps/web/src/main.tsx` (placeholder mount)**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './global.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 9: Install dependencies**

Run from repo root:
```bash
pnpm install
```
Expected: workspace links resolve; `@swarm/web` recognized under `apps/*`.

- [ ] **Step 10: Verify typecheck + dev server**

Run:
```bash
cd apps/web && pnpm run typecheck && pnpm run dev --host
```
Expected: typecheck passes; dev server starts and serves the placeholder page at `http://localhost:5173`.

- [ ] **Step 11: Commit**

```bash
git add apps/web pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(web): scaffold Vite + React app with @swarm/* and TanStack Query"
```

---

## Task 2: Transport Adapter (Browser WebSocket → ServiceTransport)

**Files:**
- Create: `apps/web/src/lib/transport-ws.ts`
- Create: `apps/web/src/lib/__tests__/transport-ws.test.ts`

**Interfaces:**
- Consumes: `ServiceTransport` from `@swarm/protocol` (alias for `RpcTransport`: `postMessage` / `on('message')` / `off('message')`).
- Produces: `createWsTransport(config: ConnectionConfig, onClose?: () => void): { transport: ServiceTransport; ready: Promise<void>; close: () => void }` — wraps a browser `WebSocket` into a `ServiceTransport`. The token is passed as a `Sec-WebSocket-Protocol` subprotocol (`swarm.<token>`). `ready` resolves on socket open. `close` closes the socket. `onClose`, if provided, fires on socket `close`/`error`.
- Produces: `ConnectionConfig` type — `{ host: string; port: number; token: string }` (defined in `parse-config.ts`, Task 3 — but referenced here as a forward type; the test in this task inlines the shape).

> **Note on ordering:** `transport-ws.ts` imports `ConnectionConfig` from `./parse-config`, which is created in Task 3. To keep tasks independently testable, this task's test imports `createWsTransport` and passes a plain object literal `{ host, port, token }`; the type annotation is structural so it compiles once Task 3 lands. If you run Task 2's test before Task 3 exists, the implementation file will fail to resolve `./parse-config` — implement Task 3 first, or temporarily inline the type. The plan executes Task 3 immediately after.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/transport-ws.test.ts`:

```ts
import type { ServiceTransport } from '@swarm/protocol'

// Minimal mock WebSocket for testing the transport adapter. Mirrors the shape
// of the browser's WebSocket the adapter touches: addEventListener / send / close / readyState.
class MockWebSocket {
  static instances: MockWebSocket[] = []
  readyState = 0 // CONNECTING
  listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  lastSent: string | undefined

  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(event: string, fn: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(fn)
  }

  removeEventListener(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn)
  }

  send(data: string): void {
    this.lastSent = data
  }

  close(): void {
    this.readyState = 3
    this.listeners.close?.forEach((fn) => fn())
  }

  // Test helpers
  _open(): void {
    this.readyState = 1
    this.listeners.open?.forEach((fn) => fn())
  }

  _message(data: unknown): void {
    this.listeners.message?.forEach((fn) => fn({ data: JSON.stringify(data) }))
  }

  _error(): void {
    this.listeners.error?.forEach((fn) => fn())
  }
}

describe('createWsTransport', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('connects with the token as a subprotocol', async () => {
    const { createWsTransport } = await import('../transport-ws')
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket)
    expect(MockWebSocket.instances[0].protocols).toBe('swarm.abc')
  })

  it('resolves ready when the socket opens', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { ready } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    expect(ready).toBeInstanceOf(Promise)
    mock._open()
    await expect(ready).resolves.toBeUndefined()
  })

  it('postMessage sends JSON-stringified message', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { transport } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket) as {
      transport: ServiceTransport
    }
    const mock = MockWebSocket.instances[0]
    transport.postMessage({ kind: 'request', id: '1', method: 'listSessions', args: [] })
    expect(mock.lastSent).toBe(JSON.stringify({ kind: 'request', id: '1', method: 'listSessions', args: [] }))
  })

  it('on/off registers and unregisters message listeners', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { transport } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket) as {
      transport: ServiceTransport
    }
    const mock = MockWebSocket.instances[0]
    const received: unknown[] = []
    const handler = (m: unknown): void => {
      received.push(m)
    }
    transport.on('message', handler)
    mock._message({ kind: 'event', event: 'test', data: 42 })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ kind: 'event', event: 'test', data: 42 })

    transport.off('message', handler)
    mock._message({ kind: 'event', event: 'test2', data: 99 })
    expect(received).toHaveLength(1)
  })

  it('close closes the underlying WebSocket', async () => {
    const { createWsTransport } = await import('../transport-ws')
    const { close } = createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, undefined, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    close()
    expect(mock.readyState).toBe(3)
  })

  it('onClose fires on socket close and error', async () => {
    const { createWsTransport } = await import('../transport-ws')
    let closed = 0
    createWsTransport({ host: '192.168.1.1', port: 47777, token: 'abc' }, () => { closed++ }, MockWebSocket)
    const mock = MockWebSocket.instances[0]
    mock._error()
    mock.close()
    // error + close both fire; onClose should fire for each, but the adapter
    // dedupes via readyState check — assert at least one invocation.
    expect(closed).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/lib/__tests__/transport-ws.test.ts`
Expected: FAIL — `Cannot find module '../transport-ws'`

- [ ] **Step 3: Implement `createWsTransport`**

Create `apps/web/src/lib/transport-ws.ts`:

```ts
import type { ServiceTransport } from '@swarm/protocol'

import type { ConnectionConfig } from './parse-config'

// The global WebSocket constructor. In the browser this is the built-in; in
// tests we inject a mock. Declared loosely so either shape is accepted.
type WebSocketLike = {
  new (url: string, protocols?: string | string[]): unknown
}

// Adapt a browser WebSocket to @swarm/protocol's ServiceTransport. The token
// is passed as a Sec-WebSocket-Protocol subprotocol (swarm.<token>), matching
// the desktop WS host's auth check. `ready` resolves on socket open. `onClose`,
// if provided, is invoked once when the socket closes or errors (e.g. the
// desktop quits or the network drops) so the caller can update connection state.
export function createWsTransport(
  config: ConnectionConfig,
  onClose?: () => void,
  WsImpl: WebSocketLike = globalThis.WebSocket
): {
  transport: ServiceTransport
  ready: Promise<void>
  close: () => void
} {
  const url = `ws://${config.host}:${config.port}`
  const protocol = `swarm.${config.token}`
  const ws = new WsImpl(url, protocol) as {
    readyState: number
    addEventListener: (event: string, fn: (...args: unknown[]) => void) => void
    send: (data: string) => void
    close: () => void
  }

  const listeners = new Set<(m: unknown) => void>()

  const onMessage = (ev: { data?: unknown }): void => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      const parsed = JSON.parse(raw)
      listeners.forEach((fn) => {
        fn(parsed)
      })
    } catch {
      /* drop malformed frames */
    }
  }

  ws.addEventListener('message', onMessage as (...args: unknown[]) => void)

  // Surface socket termination to the caller so the UI can leave the `connected`
  // state when the desktop quits or the network drops. Dedupe via readyState so
  // an error followed by close only notifies once.
  let terminated = false
  const notifyClose = (): void => {
    if (terminated) return
    terminated = true
    onClose?.()
  }
  if (onClose) {
    ws.addEventListener('close', () => notifyClose())
    ws.addEventListener('error', () => notifyClose())
  }

  const ready = new Promise<void>((resolve) => {
    if (ws.readyState === 1) resolve()
    else ws.addEventListener('open', () => resolve())
  })

  const transport: ServiceTransport = {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (_channel: 'message', fn: (m: unknown) => void) => listeners.add(fn),
    off: (_channel: 'message', fn: (m: unknown) => void) => listeners.delete(fn),
  }

  return { transport, ready, close: () => ws.close() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/lib/__tests__/transport-ws.test.ts`
Expected: PASS — all 6 tests green

> If `./parse-config` cannot be resolved (Task 3 not yet done), do Task 3 first, then re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/transport-ws.ts apps/web/src/lib/__tests__/transport-ws.test.ts
git commit -m "feat(web): add WebSocket transport adapter for @swarm/protocol"
```

---

## Task 3: Connection Config Parser

**Files:**
- Create: `apps/web/src/lib/parse-config.ts`
- Create: `apps/web/src/lib/__tests__/parse-config.test.ts`

**Interfaces:**
- Produces: `ConnectionConfig` type — `{ host: string; port: number; token: string }`.
- Produces: `parseConnectionConfig(host: string, port: string, token: string): ConnectionConfig` — trims inputs, validates non-empty host/token, parses port as integer in 1–65535. Throws `Error` with a Chinese message on any invalid input.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/parse-config.test.ts`:

```ts
import { parseConnectionConfig } from '../parse-config'

describe('parseConnectionConfig', () => {
  it('parses valid input with trimming', () => {
    expect(parseConnectionConfig('  192.168.1.100  ', ' 47777 ', '  abc123  ')).toEqual({
      host: '192.168.1.100',
      port: 47777,
      token: 'abc123',
    })
  })

  it('throws on empty host', () => {
    expect(() => parseConnectionConfig('', '47777', 'abc')).toThrow(/主机地址/)
  })

  it('throws on whitespace-only host', () => {
    expect(() => parseConnectionConfig('   ', '47777', 'abc')).toThrow(/主机地址/)
  })

  it('throws on empty token', () => {
    expect(() => parseConnectionConfig('192.168.1.1', '47777', '')).toThrow(/token/)
  })

  it('throws on non-numeric port', () => {
    expect(() => parseConnectionConfig('192.168.1.1', 'abc', 'tok')).toThrow(/端口/)
  })

  it('throws on port out of range (zero)', () => {
    expect(() => parseConnectionConfig('192.168.1.1', '0', 'tok')).toThrow(/端口/)
  })

  it('throws on port out of range (too large)', () => {
    expect(() => parseConnectionConfig('192.168.1.1', '65536', 'tok')).toThrow(/端口/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/lib/__tests__/parse-config.test.ts`
Expected: FAIL — `Cannot find module '../parse-config'`

- [ ] **Step 3: Implement `parseConnectionConfig`**

Create `apps/web/src/lib/parse-config.ts`:

```ts
export type ConnectionConfig = {
  host: string
  port: number
  token: string
}

// Validate and assemble a ConnectionConfig from raw form input. Trims all
// fields, checks host/token non-empty, parses port as an integer in 1–65535.
// Throws an Error with a Chinese message on any invalid input — the caller
// should catch and show it inline next to the form.
export function parseConnectionConfig(host: string, port: string, token: string): ConnectionConfig {
  const h = host.trim()
  const t = token.trim()
  if (!h) throw new Error('主机地址不能为空')
  if (!t) throw new Error('Token 不能为空')

  const portNum = Number.parseInt(port.trim(), 10)
  if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('端口必须是 1–65535 之间的数字')
  }

  return { host: h, port: portNum, token: t }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/lib/__tests__/parse-config.test.ts`
Expected: PASS — all 7 tests green

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/parse-config.ts apps/web/src/lib/__tests__/parse-config.test.ts
git commit -m "feat(web): add connection config parser"
```

---

## Task 4: Connection Store (Context + State Machine + EventEmitter)

**Files:**
- Create: `apps/web/src/stores/connection-store.tsx`
- Create: `apps/web/src/stores/__tests__/connection-store.test.ts`

**Interfaces:**
- Consumes: `createWsTransport` from `@/lib/transport-ws` (Task 2), `ConnectionConfig` from `@/lib/parse-config` (Task 3), `createServiceClient` + `ServiceClient` from `@swarm/protocol`.
- Produces: `ConnectionProvider` component, `useConnection()` hook returning `{ status, config, client, error, connect, disconnect, reconnect }`.
- Produces: `ConnectionStatus` type — `'idle' | 'connecting' | 'connected' | 'error'`.
- Produces: `eventEmitter` (module-level singleton) + `EventHandler` type — used by the message-event-source adapter (Task 5). Shape: `on(event: string, fn: EventHandler): () => void` and `emit(event: string, data: unknown): void`. Wildcard `'*'` subscribers receive `{ event, data }`.

- [ ] **Step 1: Write the failing test for `eventEmitter`**

Create `apps/web/src/stores/__tests__/connection-store.test.ts`:

```ts
import { eventEmitter } from '../connection-store'

describe('eventEmitter', () => {
  it('delivers events to specific subscribers', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('message.created', (data) => received.push(data))

    eventEmitter.emit('message.created', { sessionId: 's1', messageId: 'm1' })
    eventEmitter.emit('message.progress', { event: 'thinking' })

    expect(received).toEqual([{ sessionId: 's1', messageId: 'm1' }])
    unsub()
  })

  it('delivers all events to wildcard subscribers as { event, data }', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('*', (data) => received.push(data))

    eventEmitter.emit('message.created', { a: 1 })
    eventEmitter.emit('session.updated', { b: 2 })

    expect(received).toEqual([
      { event: 'message.created', data: { a: 1 } },
      { event: 'session.updated', data: { b: 2 } },
    ])
    unsub()
  })

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = []
    const unsub = eventEmitter.on('message.created', (data) => received.push(data))

    eventEmitter.emit('message.created', { first: true })
    unsub()
    eventEmitter.emit('message.created', { second: true })

    expect(received).toEqual([{ first: true }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/stores/__tests__/connection-store.test.ts`
Expected: FAIL — `Cannot find module '../connection-store'`

- [ ] **Step 3: Implement the connection store**

Create `apps/web/src/stores/connection-store.tsx`:

```tsx
import { createContext, type ReactNode, useContext, useRef, useState } from 'react'
import { createServiceClient, type ServiceClient } from '@swarm/protocol'

import type { ConnectionConfig } from '@/lib/parse-config'
import { createWsTransport } from '@/lib/transport-ws'

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

type ConnectionState = {
  status: ConnectionStatus
  config: ConnectionConfig | null
  client: ServiceClient | null
  error: string | null
  connect: (config: ConnectionConfig) => Promise<boolean>
  disconnect: () => void
  reconnect: () => Promise<boolean>
}

const ConnectionContext = createContext<ConnectionState | null>(null)

// Minimal event emitter for broadcasting RPC events to hook subscribers.
// Module-level singleton: the onEvent callback below forwards every event here,
// and the message-event-source adapter subscribes through `on('*')`.
export type EventHandler = (data: unknown) => void
export const eventEmitter = {
  handlers: new Map<string, Set<EventHandler>>(),
  on(event: string, fn: EventHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
    }
  },
  emit(event: string, data: unknown): void {
    // Wildcard subscribers receive all events, wrapped with the event name.
    this.handlers.get('*')?.forEach((fn) => {
      fn({ event, data })
    })
    this.handlers.get(event)?.forEach((fn) => {
      fn(data)
    })
  },
}

export function ConnectionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [config, setConfig] = useState<ConnectionConfig | null>(null)
  const [client, setClient] = useState<ServiceClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Keep the raw transport close fn so disconnect can tear it down. The
  // ServiceClient only detaches its own message listener, not the socket.
  const closeRef = useRef<(() => void) | null>(null)
  const clientRef = useRef<ServiceClient | null>(null)
  const configRef = useRef<ConnectionConfig | null>(null)

  const doConnect = async (cfg: ConnectionConfig): Promise<boolean> => {
    setStatus('connecting')
    setError(null)
    try {
      const { transport, ready, close } = createWsTransport(cfg, () => {
        // Socket closed unexpectedly — leave the connected state. configRef is
        // intentionally preserved so the user can reconnect from settings.
        clientRef.current = null
        closeRef.current = null
        setClient(null)
        setStatus('error')
        setError('连接已断开')
      })
      closeRef.current = close

      const sc = createServiceClient({
        transport,
        onEvent: (event, data) => {
          // Forward every RPC event to subscribers via the module emitter.
          eventEmitter.emit(event, data)
        },
      })
      await ready
      await sc.connect()

      clientRef.current = sc
      configRef.current = cfg
      setClient(sc)
      setConfig(cfg)
      setStatus('connected')
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStatus('error')
      closeRef.current = null
      clientRef.current = null
      return false
    }
  }

  const doDisconnect = (): void => {
    clientRef.current?.disconnect()
    closeRef.current?.()
    clientRef.current = null
    closeRef.current = null
    setClient(null)
    setStatus('idle')
  }

  const doReconnect = async (): Promise<boolean> => {
    const cfg = configRef.current
    if (!cfg) return false
    doDisconnect()
    return doConnect(cfg)
  }

  return (
    <ConnectionContext.Provider
      value={{
        status,
        config,
        client,
        error,
        connect: doConnect,
        disconnect: doDisconnect,
        reconnect: doReconnect,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection(): ConnectionState {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider')
  return ctx
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/stores/__tests__/connection-store.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/connection-store.tsx apps/web/src/stores/__tests__/connection-store.test.ts
git commit -m "feat(web): add connection store with state machine and event emitter"
```

---

## Task 5: Message-Event-Source Adapter + Events Bridge

**Files:**
- Create: `apps/web/src/hooks/use-message-event-source.ts`
- Create: `apps/web/src/components/events-bridge.tsx`

**Interfaces:**
- Consumes: `MessageEventSource` + `useMessageEventSubscription` from `@swarm/shared`; `useConnection` + `eventEmitter` from `@/stores/connection-store` (Task 4); `UIEvent` from `@swarm/protocol`.
- Produces: `useMessageEventSource()` hook returning `MessageEventSource | null` — adapts `ServiceClient` + `eventEmitter` into the shape `@swarm/shared` expects (`getMessageEvents(sessionId)` + `subscribeEvents(cb)`).
- Produces: `EventsBridge` component — calls `useMessageEventSubscription(source)` once at the app root so live events fold into the global `MessageRecord[]` TanStack Query cache.

- [ ] **Step 1: Implement the message-event-source hook**

Create `apps/web/src/hooks/use-message-event-source.ts`:

```ts
import { useMemo } from 'react'
import type { MessageEventSource } from '@swarm/shared'
import type { UIEvent } from '@swarm/protocol'

import { eventEmitter, useConnection } from '@/stores/connection-store'

// Adapt the web connection (ServiceClient + the connection store's eventEmitter)
// into the MessageEventSource interface expected by @swarm/shared's useMessages /
// useMessageEventSubscription. Returns null when not connected.
export function useMessageEventSource(): MessageEventSource | null {
  const { client } = useConnection()
  return useMemo(() => {
    if (!client) return null
    return {
      getMessageEvents: (sessionId) => client.getMessageEvents(sessionId),
      subscribeEvents: (cb) => {
        // The connection store's eventEmitter forwards all RPC events as
        // { event, data } envelopes on the '*' channel. Unwrap and forward the
        // data payload to the subscriber.
        return eventEmitter.on('*', (envelope) => {
          const { data } = envelope as { event: string; data: unknown }
          cb(data as UIEvent)
        })
      },
    }
  }, [client])
}
```

- [ ] **Step 2: Implement the EventsBridge component**

Create `apps/web/src/components/events-bridge.tsx`:

```tsx
import { useMessageEventSubscription } from '@swarm/shared'

import { useMessageEventSource } from '@/hooks/use-message-event-source'

// Mount once at the app root (inside ConnectionProvider + QueryClientProvider).
// Folds every live RPC event into the global MessageRecord[] TanStack Query
// cache via @swarm/shared's applyEvent, so useMessages() sees updates.
export function EventsBridge(): React.JSX.Element {
  const source = useMessageEventSource()
  useMessageEventSubscription(source)
  return <></>
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/web && pnpm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/use-message-event-source.ts apps/web/src/components/events-bridge.tsx
git commit -m "feat(web): bridge ServiceClient events into @swarm/shared message cache"
```

---

## Task 6: Root Wiring (main.tsx + App.tsx routing)

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `QueryClient`, `QueryClientProvider` from `@tanstack/react-query`; `ConnectionProvider`, `useConnection` from `@/stores/connection-store` (Task 4); `EventsBridge` from `@/components/events-bridge` (Task 5); `react-router-dom`.
- Produces: App mount with `QueryClientProvider` → `ConnectionProvider` → `EventsBridge` + router. The router has a guard: if not connected, redirect to `/connect`.

- [ ] **Step 1: Rewrite `main.tsx`**

Replace `apps/web/src/main.tsx` entirely:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import App from './App'
import { EventsBridge } from '@/components/events-bridge'
import { ConnectionProvider } from '@/stores/connection-store'
import './global.css'

const queryClient = new QueryClient()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <EventsBridge />
        <App />
      </ConnectionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
```

- [ ] **Step 2: Rewrite `App.tsx` with routing + connection guard**

Replace `apps/web/src/App.tsx` entirely:

```tsx
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom'

import { useConnection } from '@/stores/connection-store'
import { ConnectPage } from '@/pages/connect'
import { SessionDetailPage } from '@/pages/session'
import { SessionsPage } from '@/pages/sessions'
import { SettingsPage } from '@/pages/settings'

// Redirect to /connect whenever the connection drops. Placed inside the Router
// so it can use useLocation (avoids redirect loops on /connect itself).
function ConnectionGuard({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status } = useConnection()
  const location = useLocation()
  if (status !== 'connected' && location.pathname !== '/connect') {
    return <Navigate to="/connect" replace />
  }
  return <>{children}</>
}

export default function App(): React.JSX.Element {
  return (
    <Router>
      <ConnectionGuard>
        <Routes>
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/session/:id" element={<SessionDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/sessions" replace />} />
        </Routes>
      </ConnectionGuard>
    </Router>
  )
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd apps/web && pnpm run typecheck`
Expected: FAIL — the page modules (`@/pages/*`) don't exist yet. That's expected; Tasks 7–10 create them. Do NOT commit yet.

> The typecheck failure here is intentional — `App.tsx` references four page modules created in Tasks 7–10. Proceed to Task 7; the typecheck passes after Task 10.

---

## Task 7: Connect Page

**Files:**
- Create: `apps/web/src/pages/connect.tsx`

**Interfaces:**
- Consumes: `useConnection().connect` from `@/stores/connection-store` (Task 4); `parseConnectionConfig` from `@/lib/parse-config` (Task 3); `react-router-dom`'s `useNavigate`.
- Produces: `ConnectPage` — a form with host/port/token inputs. On submit, validates via `parseConnectionConfig`, calls `connect()`, and on success navigates to `/sessions`.

- [ ] **Step 1: Implement the connect page**

Create `apps/web/src/pages/connect.tsx`:

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@swarm/ui'
import { Input } from '@swarm/ui'
import { Label } from '@swarm/ui'

import { parseConnectionConfig } from '@/lib/parse-config'
import { useConnection } from '@/stores/connection-store'

export function ConnectPage(): React.JSX.Element {
  const { connect, status, error } = useConnection()
  const navigate = useNavigate()
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [token, setToken] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)
    let cfg
    try {
      cfg = parseConnectionConfig(host, port, token)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
      return
    }
    const ok = await connect(cfg)
    if (ok) navigate('/sessions')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={(e) => void handleSubmit(e)} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-card-foreground">连接到桌面端</h1>
        <p className="text-sm text-muted-foreground">
          在桌面端打开「设置 → 远程连接」获取主机地址、端口和 Token。
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="host">主机地址</Label>
          <Input id="host" placeholder="192.168.1.100" value={host} onChange={(e) => setHost(e.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="port">端口</Label>
          <Input id="port" placeholder="47777" value={port} onChange={(e) => setPort(e.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="token">Token</Label>
          <Input id="token" type="password" placeholder="swarm-xxxx" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>

        {(formError || error) && (
          <p className="text-sm text-destructive">{formError ?? error}</p>
        )}

        <Button type="submit" className="w-full" disabled={status === 'connecting'}>
          {status === 'connecting' ? '连接中…' : '连接'}
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck (partial — still missing 3 pages)**

Run: `cd apps/web && pnpm run typecheck`
Expected: still FAIL on the missing `sessions`, `session`, `settings` pages — that's fine. Proceed.

- [ ] **Step 3: Commit (the page compiles standalone; App typecheck passes after Task 10)**

```bash
git add apps/web/src/pages/connect.tsx
git commit -m "feat(web): add connect page with host/port/token form"
```

---

## Task 8: Sessions Page

**Files:**
- Create: `apps/web/src/pages/sessions.tsx`

**Interfaces:**
- Consumes: `useConnection().client` → `ServiceClient.listSessions()` from `@swarm/protocol`; `SessionSummary` type from `@swarm/protocol`; `useQuery` from `@tanstack/react-query`; `react-router-dom`'s `useNavigate` + `Link`.
- Produces: `SessionsPage` — lists sessions (title, message count, last-active date, pinned marker), refreshable, with a settings link in the header. Clicking a session navigates to `/session/:id`.

- [ ] **Step 1: Implement the sessions page**

Create `apps/web/src/pages/sessions.tsx`:

```tsx
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@swarm/ui'
import type { SessionSummary } from '@swarm/protocol'
import { Settings } from 'lucide-react'

import { useConnection } from '@/stores/connection-store'

export function SessionsPage(): React.JSX.Element {
  const { client } = useConnection()
  const navigate = useNavigate()

  const { data: sessions, error, refetch, isFetching } = useQuery<SessionSummary[]>({
    queryKey: ['sessions'],
    queryFn: () => client!.listSessions(),
    enabled: !!client,
    staleTime: 30_000,
  })

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold text-foreground">会话列表</h1>
        <Link to="/settings">
          <Button variant="ghost" size="icon" aria-label="设置">
            <Settings className="size-5" />
          </Button>
        </Link>
      </header>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <Button variant="link" size="sm" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      )}

      <ul className="flex-1 divide-y divide-border">
        {sessions?.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => navigate(`/session/${s.id}`)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent"
            >
              <span className="flex-1 truncate pr-2">
                <span className="block truncate font-medium text-foreground">
                  {s.pinned && '📌 '}
                  {s.title ?? '未命名会话'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {s.taskCount} 条消息 · {new Date(s.lastActiveAt).toLocaleDateString()}
                </span>
              </span>
            </button>
          </li>
        ))}
        {!isFetching && sessions?.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-muted-foreground">暂无会话</li>
        )}
      </ul>
    </div>
  )
}
```

> **Dependency note:** `lucide-react` is a catalog dep already used across the repo. If it isn't hoisted into `@swarm/web`, run `pnpm --filter @swarm/web add lucide-react` (it's in the catalog as `lucide-react: ^1.23.0`). Task 1's `package.json` should include it — if not, add `"lucide-react": "catalog:"` to `dependencies` and `pnpm install`.

- [ ] **Step 2: Add `lucide-react` to package.json if missing**

Check `apps/web/package.json`. If `lucide-react` is not in `dependencies`, add it:
```json
    "lucide-react": "catalog:",
```
Then run from repo root: `pnpm install`

- [ ] **Step 3: Verify typecheck (partial)**

Run: `cd apps/web && pnpm run typecheck`
Expected: still FAIL on missing `session` + `settings` pages — fine. Proceed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/sessions.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add sessions list page"
```

---

## Task 9: Session Detail Page (chat + streaming + permission)

**Files:**
- Create: `apps/web/src/pages/session.tsx`
- Create: `apps/web/src/components/segment-view.tsx`
- Create: `apps/web/src/components/permission-card.tsx`

**Interfaces:**
- Consumes: `useConnection().client` → `ServiceClient.submitPrompt()` / `decidePermission()`; `useMessages`, `hydrateSession` from `@swarm/shared`; `buildSegments`, `Segment` from `@swarm/shared`; `useQueryClient` from `@tanstack/react-query`; `useParams`, `useNavigate` from `react-router-dom`; `MessageWireEvent` from `@swarm/protocol`.
- Consumes: `Button`, `Input`, `ScrollArea` (or a plain scroll div) from `@swarm/ui`.
- Produces: `SessionDetailPage` — hydrates history on mount, reads live messages via `useMessages()`, flattens into segments via `buildSegments`, renders them, shows permission cards extracted from message events, and has an input bar that calls `submitPrompt()`.

- [ ] **Step 1: Implement `segment-view.tsx`**

Create `apps/web/src/components/segment-view.tsx`:

```tsx
import type { Segment } from '@swarm/shared'

// Render one Segment (the flattened conversational unit from buildSegments).
// Plain text only for MVP — markdown rendering is a follow-up.
export function SegmentView({ segment }: { segment: Segment }): React.JSX.Element {
  switch (segment.kind) {
    case 'user':
      return (
        <div className="flex justify-end px-4 py-1">
          <div className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground">
            {segment.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="px-4 py-1">
          <div className="max-w-[90%] whitespace-pre-wrap text-sm text-foreground">
            {segment.text}
          </div>
        </div>
      )
    case 'reasoning':
      return (
        <div className="mx-4 my-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="text-xs italic text-muted-foreground">{segment.text}</p>
        </div>
      )
    case 'tool':
      return (
        <div className="mx-4 my-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="text-sm font-medium text-foreground">
            🔧 {segment.tool}
            {segment.ok === null ? ' ⋯' : segment.ok ? ' ✓' : ' ✗'}
          </p>
          {segment.output && (
            <pre className="mt-1 max-h-40 overflow-auto text-xs text-muted-foreground">
              {segment.output}
            </pre>
          )}
        </div>
      )
    case 'error':
      return (
        <div className="mx-4 my-1 rounded-lg bg-destructive/10 px-3 py-2">
          <p className="text-sm text-destructive">
            {segment.label === 'stopped' ? '⏹' : '⚠'} {segment.detail}
          </p>
        </div>
      )
    case 'event':
      return (
        <div className="px-4 py-0.5">
          <p className="text-xs text-muted-foreground">
            {segment.label}: {segment.detail}
          </p>
        </div>
      )
  }
}
```

- [ ] **Step 2: Implement `permission-card.tsx`**

Create `apps/web/src/components/permission-card.tsx`:

```tsx
import { Button } from '@swarm/ui'

export type PermissionPrompt = {
  messageId: string
  actionId: string
  risk: string
  summary: string
}

export function PermissionCard({
  perm,
  onDecide,
}: {
  perm: PermissionPrompt
  onDecide: (decision: 'grant' | 'deny') => void
}): React.JSX.Element {
  return (
    <div className="mx-4 my-1 rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3">
      <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
        {perm.risk} 风险操作 · 需要审批
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{perm.summary}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => onDecide('grant')}>
          批准
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide('deny')}>
          拒绝
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Implement the session detail page**

Create `apps/web/src/pages/session.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@swarm/ui'
import { Input } from '@swarm/ui'
import { ChevronLeft } from 'lucide-react'
import { buildSegments, hydrateSession, useMessages } from '@swarm/shared'
import type { MessageWireEvent } from '@swarm/protocol'

import { PermissionCard, type PermissionPrompt } from '@/components/permission-card'
import { SegmentView } from '@/components/segment-view'
import { useConnection } from '@/stores/connection-store'

export function SessionDetailPage(): React.JSX.Element {
  const { id: sessionId } = useParams<{ id: string }>()
  const { client } = useConnection()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const messages = useMessages()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Hydrate history on mount / session switch. The subscribeEvents half of the
  // MessageEventSource is handled globally by EventsBridge, so here we pass a
  // no-op subscribeEvents — hydrateSession only needs getMessageEvents.
  useEffect(() => {
    if (!client || !sessionId) return
    void hydrateSession(
      qc,
      { getMessageEvents: (sid) => client.getMessageEvents(sid), subscribeEvents: () => () => {} },
      sessionId,
    )
  }, [client, sessionId, qc])

  // Filter + order the global MessageRecord[] for this session, newest-first
  // (matches mobile's order convention), then flatten into render segments.
  const segments = useMemo(() => {
    const sessionMessages = messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => b.order - a.order)
    return sessionMessages.flatMap((r) => buildSegments(r.events))
  }, [messages, sessionId])

  // Extract pending permission_request prompts for this session.
  const permissions = useMemo<PermissionPrompt[]>(() => {
    const perms: PermissionPrompt[] = []
    for (const msg of messages.filter((m) => m.sessionId === sessionId)) {
      for (const evt of msg.events) {
        const wire = evt as MessageWireEvent
        if (wire.kind === 'message.permission_request' && wire.sessionId === sessionId) {
          perms.push({
            messageId: wire.messageId,
            actionId: wire.actionId,
            risk: wire.risk,
            summary: wire.summary,
          })
        }
      }
    }
    return perms
  }, [messages, sessionId])

  // Auto-scroll to bottom on new segments.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [segments.length])

  const handleSend = async (): Promise<void> => {
    if (!client || !sessionId || !input.trim()) return
    const text = input.trim()
    setInput('')
    try {
      await client.submitPrompt(sessionId, text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handlePermission = async (perm: PermissionPrompt, decision: 'grant' | 'deny'): Promise<void> => {
    if (!client || !sessionId) return
    try {
      await client.decidePermission(sessionId, perm.actionId, decision)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mx-auto flex h-screen max-w-2xl flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={() => navigate('/sessions')}>
          <ChevronLeft className="size-5" />
        </Button>
        <h1 className="text-base font-semibold text-foreground">会话详情</h1>
      </header>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-1">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-0.5 overflow-y-auto py-2">
        {segments.map((seg) => (
          <SegmentView key={seg.key} segment={seg} />
        ))}
        {segments.length === 0 && (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">暂无消息</p>
        )}
      </div>

      {permissions.length > 0 && (
        <div className="space-y-1 border-t border-border px-0 py-2">
          {permissions.map((perm) => (
            <PermissionCard
              key={perm.actionId}
              perm={perm}
              onDecide={(d) => void handlePermission(perm, d)}
            />
          ))}
        </div>
      )}

      <form
        className="flex items-center gap-2 border-t border-border px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void handleSend()
        }}
      >
        <Input
          className="flex-1"
          placeholder="输入消息…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button type="submit" disabled={!input.trim()}>
          发送
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 4: Verify typecheck (partial — still missing settings page)**

Run: `cd apps/web && pnpm run typecheck`
Expected: still FAIL on missing `settings` page — fine. Proceed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/session.tsx apps/web/src/components/segment-view.tsx apps/web/src/components/permission-card.tsx
git commit -m "feat(web): add session detail page with streaming segments and permission cards"
```

---

## Task 10: Settings Page

**Files:**
- Create: `apps/web/src/pages/settings.tsx`

**Interfaces:**
- Consumes: `useConnection().config`, `status`, `disconnect`, `reconnect` from `@/stores/connection-store` (Task 4); `react-router-dom`'s `useNavigate`.
- Produces: `SettingsPage` — shows connection status, the desktop address, and disconnect / reconnect buttons.

- [ ] **Step 1: Implement the settings page**

Create `apps/web/src/pages/settings.tsx`:

```tsx
import { useNavigate } from 'react-router-dom'
import { Button } from '@swarm/ui'

import { useConnection } from '@/stores/connection-store'

export function SettingsPage(): React.JSX.Element {
  const { config, status, disconnect, reconnect } = useConnection()
  const navigate = useNavigate()

  const statusText =
    status === 'connected'
      ? '已连接'
      : status === 'connecting'
        ? '连接中…'
        : status === 'error'
          ? '连接错误'
          : '未连接'

  const handleDisconnect = (): void => {
    disconnect()
    navigate('/connect')
  }

  const handleReconnect = async (): Promise<void> => {
    const ok = await reconnect()
    if (!ok) navigate('/connect')
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={() => navigate('/sessions')}>
          ←
        </Button>
        <h1 className="text-base font-semibold text-foreground">连接设置</h1>
      </header>

      <div className="space-y-4 px-4 py-4">
        <div className="rounded-lg border border-border p-3">
          <p className="text-sm text-muted-foreground">状态</p>
          <p className="text-sm text-foreground">{statusText}</p>
        </div>

        {config && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-sm text-muted-foreground">桌面端地址</p>
            <p className="font-mono text-sm text-foreground">
              {config.host}:{config.port}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Button className="w-full" onClick={() => void handleReconnect()} disabled={status !== 'connected'}>
            重新连接
          </Button>
          <Button variant="outline" className="w-full" onClick={handleDisconnect}>
            断开连接
          </Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify typecheck (now all pages exist)**

Run: `cd apps/web && pnpm run typecheck`
Expected: PASS — no type errors across the whole app

- [ ] **Step 3: Verify all tests still pass**

Run: `cd apps/web && pnpm run test`
Expected: PASS — all unit tests (Tasks 2, 3, 4) green

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/settings.tsx
git commit -m "feat(web): add connection settings page"
```

---

## Task 11: Manual E2E Verification

This task has no code — it's a manual verification checklist to confirm the full stack works end-to-end.

- [ ] **Step 1: Start the desktop app**

Run: `cd apps/desktop && pnpm dev`
Expected: Desktop app launches; WS host starts on `0.0.0.0:47777` (or the configured port).

- [ ] **Step 2: Note the connection info**

Open Settings → 远程连接 in the desktop app. Note the LAN IP, port, and token (or scan the QR — the QR encodes `swarm:<ip>:<port>?token=<token>`; read off the three parts).

- [ ] **Step 3: Start the web app**

Run: `cd apps/web && pnpm dev`
Expected: Vite dev server starts at `http://localhost:5173`.

- [ ] **Step 4: Connect from the browser**

Open `http://localhost:5173`. Enter the host (LAN IP), port, and token from Step 2. Click "连接".
Expected: Connects within a few seconds; navigates to the session list.

- [ ] **Step 5: Verify session list appears**

Expected: The browser shows the same sessions as the desktop app.

- [ ] **Step 6: Send a message**

Click a session → type a prompt → press Enter or click "发送".
Expected: The user bubble appears; assistant segments stream in as the agent works.

- [ ] **Step 7: Test permission approval**

Trigger a permission-gated action (e.g. ask the agent to run a shell command with permission mode set to prompt).
Expected: A yellow permission card appears → click "批准" → the agent continues.

- [ ] **Step 8: Test disconnect**

Stop the desktop app (quit it). Expected: the web app shows the connection error and redirects to `/connect`. Restart the desktop app, reconnect from the web app — it works again.

- [ ] **Step 9: Test the settings screen**

From the session list, click the gear icon → settings page shows status "已连接" and the desktop address. Click "断开连接" → returns to `/connect`.

- [ ] **Step 10: Final commit (if any fixups were made during E2E)**

```bash
git add -A
git commit -m "fix(web): e2e verification adjustments"
```

---

## Self-Review Checklist

**1. Spec coverage:**

| Spec requirement | Task(s) |
|---|---|
| Vite + React SPA scaffold under `apps/web` | Task 1 |
| `@swarm/protocol`, `@swarm/shared`, `@swarm/ui`, `@tanstack/react-query` deps | Task 1 (package.json + catalog) |
| `@` → `./src` path alias | Task 1 (tsconfig + vite.config) |
| Browser WebSocket → ServiceTransport adapter | Task 2 |
| Token as `Sec-WebSocket-Protocol` subprotocol (never in URL/logs) | Task 2 (transport) + Task 4 (store — no log of token) |
| Connection config parser + validation | Task 3 |
| Connection store (state machine + Context) | Task 4 |
| Event emitter (module-level singleton) | Task 4 |
| Reuse `@swarm/shared` message infra (MessageEventSource / useMessages / hydrateSession / buildSegments) | Task 5 (adapter + bridge) + Task 9 (consumer) |
| Root wiring: QueryClientProvider → ConnectionProvider → EventsBridge → Router | Task 6 |
| Connection guard (redirect to /connect when disconnected) | Task 6 |
| Connect page (host/port/token form) | Task 7 |
| Sessions list (TanStack Query over listSessions) + settings entry | Task 8 |
| Session detail: history hydrate + streaming segments + input + permission | Task 9 |
| Segment rendering (user/assistant/reasoning/tool/error/event) | Task 9 (segment-view) |
| Permission approval cards | Task 9 (permission-card + session page extraction) |
| Settings page (status / disconnect / reconnect) | Task 10 |
| Error handling: bad token, host unreachable, socket drop, RPC fail, form validation | Task 2 (onClose), Task 4 (state machine), Task 7 (form error), Task 8 (query error + retry), Task 9 (RPC error), Task 6 (guard redirect) |
| No persistence (in-memory only, reload → /connect) | Task 4 (no localStorage) + Task 6 (guard) |
| Unit tests: parse-config, transport-ws, eventEmitter | Task 3, Task 2, Task 4 |
| Manual E2E | Task 11 |
| English comments + commits, Chinese UI text | All tasks |

**2. Placeholder scan:** ✅ No TBD/TODO. All code steps contain complete code.

**3. Type consistency:**
- `ConnectionConfig` = `{ host: string; port: number; token: string }` — defined in Task 3 (`parse-config.ts`), imported by Task 2 (`transport-ws.ts`) and Task 4 (`connection-store.tsx`). Consistent.
- `createWsTransport(config: ConnectionConfig, onClose?, WsImpl?)` returns `{ transport, ready, close }` — Task 2 defines it; Task 4 consumes it with `createWsTransport(cfg, () => {...})`. The second arg is `onClose`, matching the signature. Consistent.
- `ConnectionStatus` = `'idle' | 'connecting' | 'connected' | 'error'` — Task 4 defines; Task 6 (guard) and Task 10 (settings) consume `status`. Consistent.
- `eventEmitter.on('*', handler)` delivers `{ event, data }` envelope; specific events deliver `data` — Task 4 defines (emit), Task 4 tests assert, Task 5 (`useMessageEvent-source`) unwraps `envelope.data`. Consistent.
- `MessageEventSource` shape from `@swarm/shared`: `{ getMessageEvents(sessionId): Promise<...[]>, subscribeEvents(cb): () => void }` — Task 5's `useMessageEventSource` returns exactly this; Task 9's `hydrateSession` call passes a compatible inline object. Consistent.
- `Segment` from `@swarm/shared` — Task 9 `segment-view.tsx` exhaustively switches on `segment.kind` across all 6 variants (user/assistant/reasoning/tool/error/event). Consistent with `buildSegments` output.
- `ServiceClient` methods used: `listSessions()`, `getMessageEvents(sessionId)`, `submitPrompt(sessionId, prompt)`, `decidePermission(sessionId, actionId, decision)` — all match the signatures in `service-client.ts`. `submitPrompt` is called with 2 args in Task 9 (sessionId, text); the protocol signature is `submitPrompt(sessionId, prompt, attachments?, options?)` — the optional 3rd/4th args are correctly omitted. Consistent.
- `PermissionPrompt` type defined in Task 9 (`permission-card.tsx`) with `{ messageId, actionId, risk, summary }`; extracted in `session.tsx` from `MessageWireEvent` fields `messageId`, `actionId`, `risk`, `summary` — all present on `message.permission_request`. Consistent.
- Page module exports are named exports (`ConnectPage`, `SessionsPage`, `SessionDetailPage`, `SettingsPage`); `App.tsx` imports them as named. Consistent.
