# Desktop WebSocket Host (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a loopback WebSocket server in the desktop main process that bridges an external client (extension/RN) 1:1 to the existing service sidecar transport, so `ServiceClient` works unchanged over WS. v1: single external peer, token-gated, heartbeat-kept.

**Architecture:** A new `apps/desktop/src/main/host/` slice owns a `ws.WebSocketServer` bound to `127.0.0.1`. On a peer's authenticated connect, the host registers a second `message` listener on the existing `serviceProcess` (the Electron utilityProcess that is already the main `serviceClient`'s transport) and relays every service→main message to the peer, while forwarding every peer message to `serviceProcess.postMessage`. Both the main `serviceClient` and the peer's `ServiceClient` see all messages and match by request id — so the service sees a second logical client on the same transport (spec §7.2/§7.4 Option A). Port + token persist to `userData/ws-host.json` for client discovery. `service-client.ts`'s "unknown request id" warning is silenced (the peer's responses will have ids the main client doesn't know).

**Tech Stack:** `ws` (WebSocketServer), `@types/ws`, Electron `utilityProcess`, `crypto.randomBytes`, `@swarm/protocol` (`ServiceClient`/`ServiceTransport`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-multiplatform-structure-design.md` (§6.1 host/, §7 transport-over-WS, §10 Phase 4, §11 #3 acceptance, §14 #3 subprotocol auth).

## Global Constraints

- **Language:** Code comments and commit messages in English. Conversation in Chinese.
- **Tests:** `npm test` (Electron node). NEVER bare `npx vitest`. NEVER `pnpm rebuild better-sqlite3`.
- **Format:** Scope with `npx biome check --write <file>`.
- **Boundary:** `apps/desktop/src/main/host/` MAY import `@swarm/protocol`, `electron`, `ws`, `node:*`. (It is a desktop-only slice — NOT a `@swarm/*` package, so the boundary lint does not constrain it.)
- **Loopback only:** bind `127.0.0.1`, never `0.0.0.0`.
- **Token transport:** `Sec-WebSocket-Protocol` subprotocol `swarm.<token>` (not a URL query param — URLs get logged).
- **v1 scope:** one external peer at a time; reject a second. No clientId multiplexing (spec §7.4 Option B deferred). No TLS/mTLS (loopback + token suffices for single-user v1).
- **Logging:** Every business path (peer connect/disconnect/reject, host start, errors) logged under a `ws-host` child logger per CLAUDE.md §5.
- **Worktree:** Execute in `worktree-desktop-ws-host`. One commit per task.

---

## File Structure

**Create `apps/desktop/src/main/host/`:**
- `auth.ts` (+ test) — random token generation + `ws-host.json` (port+token) persistence.
- `ws-server.ts` (+ test) — `ws.WebSocketServer` on `127.0.0.1:<port>`, subprotocol token gate, single-peer enforcement.
- `bridge.ts` (+ test) — wires a connected peer to the service transport (relay both ways + heartbeat).
- `index.ts` — `startWsHost({ serviceProcess, app, log })`: picks a port, loads/creates token, starts server, returns a `dispose()`.

**Modify:**
- `apps/desktop/package.json` — add `ws` + `@types/ws`.
- `apps/desktop/src/main/index.ts` — call `startWsHost` after `serviceClient.connect()`, dispose on `before-quit`.
- `packages/protocol/src/service-client.ts` — silence the "unknown request id" path (the peer's responses will trigger it in main's client).

---

## Task 1: Add `ws` dep + token/host-file persistence (TDD)

**Files:**
- Create: `apps/desktop/src/main/host/auth.ts`, `apps/desktop/src/main/host/auth.test.ts`
- Modify: `apps/desktop/package.json` (add `ws` + `@types/ws`)
- Test: `auth.test.ts`.

**Interfaces:**
- Produces: `generateToken(): string` (32-byte hex); `loadOrCreateHostConfig(userDataDir: string): { port: number; token: string }` — reads `ws-host.json`, creates it with a fresh token + fixed port if absent.

- [ ] **Step 1: Add deps**

```bash
pnpm --filter @swarm/desktop add ws
pnpm --filter @swarm/desktop add -D @types/ws
```

- [ ] **Step 2: Write the failing test**

`apps/desktop/src/main/host/auth.test.ts`:
```typescript
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken, loadOrCreateHostConfig } from './auth'

describe('ws host auth', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ws-host-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('generateToken returns 32-byte hex', () => {
    const t = generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(generateToken()).not.toBe(t)
  })

  it('loadOrCreateHostConfig creates ws-host.json on first call', () => {
    const cfg = loadOrCreateHostConfig(dir)
    expect(cfg.port).toBeGreaterThan(1024)
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/)
    const onDisk = JSON.parse(readFileSync(join(dir, 'ws-host.json'), 'utf8'))
    expect(onDisk).toEqual({ port: cfg.port, token: cfg.token })
  })

  it('loadOrCreateHostConfig reuses existing port+token', () => {
    const first = loadOrCreateHostConfig(dir)
    const second = loadOrCreateHostConfig(dir)
    expect(second).toEqual(first)
  })
})
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
npm test -- apps/desktop/src/main/host/auth.test.ts
```
Expected: FAIL "Cannot find module './auth'".

- [ ] **Step 4: Implement**

`apps/desktop/src/main/host/auth.ts`:
```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const HOST_CONFIG = 'ws-host.json'
// Loopback-only port for the agent-runtime WS host. Fixed so clients can
// discover it alongside the token in userData/ws-host.json.
const DEFAULT_PORT = 47777

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export type HostConfig = { port: number; token: string }

export function loadOrCreateHostConfig(userDataDir: string): HostConfig {
  const file = join(userDataDir, HOST_CONFIG)
  if (existsSync(file)) {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as HostConfig
    if (typeof cfg.port === 'number' && typeof cfg.token === 'string') return cfg
  }
  const cfg: HostConfig = { port: DEFAULT_PORT, token: generateToken() }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  return cfg
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
npm test -- apps/desktop/src/main/host/auth.test.ts
```
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/main/host/auth.ts apps/desktop/src/main/host/auth.test.ts pnpm-lock.yaml
git commit -m "feat(host): ws token + ws-host.json persistence"
```

---

## Task 2: WS server — loopback bind, subprotocol token gate, single peer (TDD)

**Files:**
- Create: `apps/desktop/src/main/host/ws-server.ts`, `apps/desktop/src/main/host/ws-server.test.ts`
- Test: `ws-server.test.ts`.

**Interfaces:**
- Consumes: `HostConfig` from Task 1.
- Produces: `startWsServer({ port, token, onPeer, log }): { server: WebSocketServer; close(): void }` — on a peer that presents the correct subprotocol, calls `onPeer(ws)`; extra peers are rejected (1008, "another client is connected"). Bad token → close 1008.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/host/ws-server.test.ts`:
```typescript
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { startWsServer } from './ws-server'

describe('ws server', () => {
  // Each test starts its own server on port 0 and closes it in finally.

  it('accepts a peer with the correct subprotocol token', async () => {
    let connected = false
    const r = startWsServer({ port: 0, token: 'tok', onPeer: () => { connected = true }, log: console })
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.tok')
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
      expect(connected).toBe(true)
      ws.close()
    } finally { r.close() }
  })

  it('rejects a peer with the wrong token (close 1008)', async () => {
    const r = startWsServer({ port: 0, token: 'tok', onPeer: () => {}, log: console })
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.wrong')
      const code = await new Promise<number>((res) => ws.once('close', (c) => res(c)))
      expect(code).toBe(1008)
    } finally { r.close() }
  })

  it('rejects a second peer while one is connected', async () => {
    const r = startWsServer({ port: 0, token: 'tok', onPeer: () => {}, log: console })
    try {
      const first = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.tok')
      await new Promise((res, rej) => { first.once('open', res); first.once('error', rej) })
      const second = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.tok')
      const code = await new Promise<number>((res) => second.once('close', (c) => res(c)))
      expect(code).toBe(1008)
      first.close()
    } finally { r.close() }
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './ws-server'`).

- [ ] **Step 3: Implement**

`apps/desktop/src/main/host/ws-server.ts`:
```typescript
import { WebSocketServer, WebSocket } from 'ws'
import type { HostConfig } from './auth'

export type WsServerLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

export type StartWsServer = {
  port: number
  token: string
  onPeer: (ws: WebSocket) => void
  log: WsServerLog
}

// Bind 127.0.0.1 only; require the token as a Sec-WebSocket-Protocol subprotocol
// (swarm.<token>) so it never appears in URLs/logs. Allow one peer at a time.
export function startWsServer(cfg: StartWsServer): { server: WebSocketServer; port: number; close: () => void } {
  let peer: WebSocket | null = null
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: cfg.port,
    handleProtocols: (protocols: Set<string>): string | false => {
      const want = `swarm.${cfg.token}`
      return protocols.has(want) ? want : false
    },
  })
  const port = server.address().toString() === '[object Object]'
    ? (server.address() as { port: number }).port
    : cfg.port
  server.on('connection', (ws, req) => {
    // handleProtocols already rejected bad tokens (connection never reaches here
    // without a valid subprotocol), but double-check defensively.
    if (peer && peer.readyState === WebSocket.OPEN) {
      cfg.log.warn({ msg: 'ws-host second peer rejected', ip: req.socket.remoteAddress })
      ws.close(1008, 'another client is connected')
      return
    }
    peer = ws
    cfg.log.info({ msg: 'ws-host peer connected', ip: req.socket.remoteAddress })
    ws.on('close', () => {
      if (peer === ws) peer = null
      cfg.log.info({ msg: 'ws-host peer disconnected' })
    })
    cfg.onPeer(ws)
  })
  return { server, port, close: () => server.close() }
}
```

- [ ] **Step 4: Run — expect PASS** (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/host/ws-server.ts apps/desktop/src/main/host/ws-server.test.ts
git commit -m "feat(host): ws server with subprotocol token gate + single-peer"
```

---

## Task 3: Bridge — peer ↔ service relay + heartbeat (TDD)

**Files:**
- Create: `apps/desktop/src/main/host/bridge.ts`, `apps/desktop/src/main/host/bridge.test.ts`
- Test: `bridge.test.ts`.

**Interfaces:**
- Consumes: `ServiceTransport` from `@swarm/protocol`; a connected `WebSocket` from Task 2.
- Produces: `attachBridge({ peer, service, log }): () => void` — relays peer→service and service→peer; heartbeat (peer ping every 20s, host echoes). Returns a `detach()` to remove the listeners on disconnect.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/host/bridge.test.ts`:
```typescript
import { EventEmitter } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachBridge } from './bridge'

// A fake service transport: structured like the Electron utilityProcess —
// postMessage + EventEmitter 'message'. The host's main serviceClient uses the
// same shape, so a peer sharing it sees the same traffic.
function fakeServiceTransport() {
  const bus = new EventEmitter()
  return {
    postMessage: (m: unknown) => bus.emit('message', m),
    on: (_ch: 'message', fn: (m: unknown) => void) => bus.on('message', fn),
    off: (_ch: 'message', fn: (m: unknown) => void) => bus.off('message', fn),
    emit: (m: unknown) => bus.emit('message', m), // test hook to simulate service→main
  }
}

describe('ws bridge', () => {
  let server: WebSocketServer
  let port: number
  beforeEach((done) => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      port = (server.address() as { port: number }).port; done()
    })
  })
  afterEach(() => server.close())

  it('relays peer→service (peer sends request JSON, service transport gets it)', async () => {
    const svc = fakeServiceTransport()
    const received: unknown[] = []
    svc.on('message', (m) => received.push(m))
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc, log: console }))

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    ws.send(JSON.stringify({ kind: 'request', id: 1, method: 'listAgents', args: [] }))
    await new Promise((res) => setTimeout(res, 50))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ kind: 'request', id: 1, method: 'listAgents' })
    ws.close()
  })

  it('relays service→peer (service posts response, peer receives JSON)', async () => {
    const svc = fakeServiceTransport()
    server.on('connection', (ws) => attachBridge({ peer: ws, service: svc, log: console }))
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    const seen: unknown[] = []
    ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())))

    svc.emit({ kind: 'response', id: 1, ok: true, result: { agents: [] } })
    await new Promise((res) => setTimeout(res, 50))
    expect(seen[0]).toMatchObject({ kind: 'response', id: 1, ok: true })
    ws.close()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module './bridge'`).

- [ ] **Step 3: Implement**

`apps/desktop/src/main/host/bridge.ts`:
```typescript
import type { WebSocket } from 'ws'
import type { ServiceTransport } from '@swarm/protocol'

export type BridgeLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

export type AttachBridge = {
  peer: WebSocket
  service: ServiceTransport
  log: BridgeLog
}

// Wire one WS peer to the service transport: peer JSON → service.postMessage;
// service 'message' → peer.send(JSON). Heartbeat: ws pong resets the idle
// timer; main serviceClient is unaffected (it keeps its own 'message' handler
// and simply ignores ids it didn't open — see service-client.ts).
export function attachBridge(cfg: AttachBridge): () => void {
  const { peer, service, log } = cfg

  const onPeerMessage = (raw: unknown): void => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
      service.postMessage(msg)
    } catch (err) {
      log.warn({ msg: 'ws-host peer sent invalid json', err: String(err) })
    }
  }
  const onServiceMessage = (msg: unknown): void => {
    if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg))
  }

  peer.on('message', onPeerMessage)
  service.on('message', onServiceMessage)
  // Heartbeat: the peer (extension SW / RN) pings; ws auto-answers with pong.
  peer.on('ping', () => log.info({ msg: 'ws-host ping' }))

  log.info({ msg: 'ws-host bridge attached' })
  return () => {
    peer.off('message', onPeerMessage)
    service.off('message', onServiceMessage)
    peer.off('ping', () => {})
    log.info({ msg: 'ws-host bridge detached' })
  }
}
```

- [ ] **Step 4: Run — expect PASS** (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/host/bridge.ts apps/desktop/src/main/host/bridge.test.ts
git commit -m "feat(host): peer ↔ service relay bridge + heartbeat"
```

---

## Task 4: end-to-end loopback integration test (ServiceClient over WS)

**Files:**
- Create: `apps/desktop/src/main/host/host.test.ts`
- Create: `apps/desktop/src/main/host/index.ts` (composes auth + server + bridge)
- Test: `host.test.ts`.

**Interfaces:**
- Produces: `startWsHost({ serviceProcess, userDataDir, log }): Promise<{ port: number; token: string; dispose: () => void }>` — composes Task 1–3; used by `main/index.ts`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/main/host/host.test.ts`:
```typescript
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceClient, type ServiceTransport } from '@swarm/protocol'
import { startWsHost } from './index'

// Fake service sidecar: receives requests via postMessage, emits a canned
// response for 'listAgents'.
function fakeServiceProcess(): ServiceTransport & { emit: (m: unknown) => void } {
  const bus = new EventEmitter()
  const proc = {
    postMessage: (m: unknown) => {
      const req = m as { id: number; method: string }
      bus.emit('message', { kind: 'response', id: req.id, ok: true, result: { agents: ['ceo', 'worker'] } })
    },
    on: (_ch: 'message', fn: (m: unknown) => void) => bus.on('message', fn),
    off: (_ch: 'message', fn: (m: unknown) => void) => bus.off('message', fn),
    emit: (m: unknown) => bus.emit('message', m),
  }
  return proc as ServiceTransport & { emit: (m: unknown) => void }
}

// A WS transport that satisfies @swarm/protocol's ServiceTransport interface
// (used by the external client — exactly what the extension/RN will build).
function wsTransport(ws: WebSocket): ServiceTransport {
  return {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (ch: 'message', fn: (m: unknown) => void) => ws.on('message', (raw) => fn(JSON.parse(raw.toString()))),
    off: () => {}, // ws is short-lived for the test; not needed
  }
}

describe('startWsHost (loopback integration)', () => {
  let dir: string
  let dispose: () => void
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ws-host-e2e-')) })
  afterEach(() => { try { dispose() } catch { /* noop */ } rmSync(dir, { recursive: true, force: true }) })

  it('an external ServiceClient over WS can call listAgents and get the service response', async () => {
    const serviceProcess = fakeServiceProcess()
    const host = await startWsHost({ serviceProcess, userDataDir: dir, log: console })
    dispose = host.dispose

    const ws = new WebSocket(`ws://127.0.0.1:${host.port}`, `swarm.${host.token}`)
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    const client = createServiceClient({ transport: wsTransport(ws) })
    await client.connect()
    const result = await client.listAgents()
    expect((result as { agents: unknown[] }).agents).toEqual(['ceo', 'worker'])
    client.disconnect(); ws.close()
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`startWsHost` not implemented).

- [ ] **Step 3: Implement `index.ts`**

`apps/desktop/src/main/host/index.ts`:
```typescript
import { loadOrCreateHostConfig } from './auth'
import { startWsServer } from './ws-server'
import { attachBridge } from './bridge'
import type { ServiceTransport } from '@swarm/protocol'

export type StartWsHost = {
  serviceProcess: ServiceTransport
  userDataDir: string
  log: { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }
}

// Boot the agent-runtime WS host: load/create port+token, start the loopback
// server, and attach a bridge on each authenticated peer. Returns dispose().
export async function startWsHost(cfg: StartWsHost): Promise<{ port: number; token: string; dispose: () => void }> {
  const { port, token } = loadOrCreateHostConfig(cfg.userDataDir)
  const { server, port: boundPort, close } = startWsServer({
    port,
    token,
    log: cfg.log,
    onPeer: (peer) => {
      let detach = () => {}
      detach = attachBridge({ peer, service: cfg.serviceProcess, log: cfg.log })
      peer.on('close', () => detach())
    },
  })
  await new Promise<void>((res) => server.once('listening', res))
  cfg.log.info({ msg: 'ws-host started', port: boundPort })
  return { port: boundPort, token, dispose: close }
}
```

- [ ] **Step 4: Run — expect PASS** (integration test green; an external `ServiceClient` over real WS reaches the fake service).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/host/index.ts apps/desktop/src/main/host/host.test.ts
git commit -m "feat(host): startWsHost compose + loopback integration test"
```

---

## Task 5: Wire into main boot + silence unknown-id + app smoke

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (call `startWsHost` after `serviceClient.connect()`, dispose on `before-quit`).
- Modify: `packages/protocol/src/service-client.ts` (silence "unknown request id" — the peer's responses hit this in main's client).
- Test: full suite green + app launches with WS host up (driver smoke + a manual WS probe).

**Interfaces:**
- Consumes: `startWsHost` from Task 4.

- [ ] **Step 1: Silence unknown-id in service-client**

`packages/protocol/src/service-client.ts` — find the existing branch:
```typescript
        log.warn({ msg: 'response for unknown request id', id: msg.id })
```
Replace the `log.warn(...)` with a debug-level no-op (the protocol client is now shared with an external WS peer via the host bridge; its response ids are foreign to main's client by design). Concretely, change it to:
```typescript
        // The desktop host bridges an external WS peer onto the same service
        // transport; that peer's response ids are foreign to this client. Drop.
```
(Delete the `log.warn` line; keep the surrounding branch shape.)

- [ ] **Step 2: Wire startWsHost into main boot**

In `apps/desktop/src/main/index.ts`, after `await serviceClient.connect()` (line ~129) and before `gmail.registerMainRpc(...)`, add:
```typescript
    // External clients (extension/RN) bridge to the service over a loopback WS.
    const wsHost = await startWsHost({ serviceProcess, userDataDir: app.getPath('userData'), log })
    log.info({ msg: 'ws-host up', port: wsHost.port })
```
Add to the imports at the top:
```typescript
import { startWsHost } from './host'
```
And in the existing `app.on('before-quit', ...)` block (currently calls `serviceClient.disconnect()` + `serviceProcess.kill()`), add `wsHost.dispose()` before them.

- [ ] **Step 3: Run the full suite**

```bash
pnpm --filter @swarm/desktop run typecheck
pnpm --filter @swarm/desktop run test
pnpm --filter @swarm/desktop run build
node tools/check-boundaries.mjs
```
Expected: typecheck clean, tests green (including the new host suite), build green, boundary OK.

- [ ] **Step 4: Smoke: app launches with WS host up**

```bash
SWARM_USER_DATA_DIR=/tmp/swarm-plan3 node .claude/skills/run-desktop/driver.mjs
# REPL: launch → ss main → quit
```
Expected: window opens + renders (unchanged). Then verify the host actually responds over WS — open a second terminal:
```bash
node -e "const{WebSocket:e}=require('ws');const f='/tmp/swarm-plan3/ws-host.json';const c=require(f);const w=new e(\`ws://127.0.0.1:\${c.port}\`,'swarm.'+c.token);w.on('open',()=>{w.send(JSON.stringify({kind:'request',id:1,method:'listAgents',args:[]}));});w.on('message',d=>{console.log('reply:',d.toString());w.close();process.exit(0)});"
```
Expected: a JSON `ServiceResponse` with `listAgents` result. Stop the dev app.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts packages/protocol/src/service-client.ts
git commit -m "feat(host): wire WS host into main boot + silence cross-client unknown-id"
```

---

## Acceptance

Plan 3 is complete when **all** hold:

1. `apps/desktop/src/main/host/` exists with auth/ws-server/bridge/index (+ tests), all imported by `main/index.ts`.
2. `ws-host.json` is written to `userData/` on first boot with `{port, token}` and reused after.
3. The loopback integration test (`host.test.ts`) proves an external `ServiceClient` over real WS drives `listAgents` against a fake service and gets the response — without launching Electron.
4. The token gate rejects a wrong-token peer (close 1008); a second peer is rejected while one is connected.
5. `tools/check-boundaries.mjs` still passes (host is a desktop slice, not a `@swarm/*` package).
6. `turbo run typecheck/test/build` green from root.
7. Manual WS probe (Step 4) returns a `ServiceResponse` from the running app.

After Plan 3 lands, proceed to Plan 4 (Chrome MV3 extension skeleton, Phase 5) — the first real external consumer of this host.
