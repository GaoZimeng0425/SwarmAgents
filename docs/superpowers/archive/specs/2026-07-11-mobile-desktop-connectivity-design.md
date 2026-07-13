# Mobile ↔ Desktop Connectivity — LAN Pairing Design

**Status:** Proposed
**Date:** 2026-07-11
**Scope:** Connect the Expo mobile app (`apps/mobile`) to the Electron desktop host (`apps/desktop`) over LAN WebSocket, enabling QR-code pairing, session browsing, real-time message streaming, prompt sending, and permission approval from a phone.

---

## 1. Background & Motivation

The monorepo has three apps: `apps/desktop` (Electron host), `apps/extension` (browser extension), and `apps/mobile` (Expo/React Native). The desktop app already runs a WebSocket host (`apps/desktop/src/main/host/`) designed for external clients — the browser extension connects to it today using `@swarm/protocol`'s symmetric RPC over WS.

The mobile app is a fresh Expo + Gluestack UI starter kit with zero networking code and no dependency on `@swarm/protocol`. The desktop host's `remote-view.tsx` explicitly states the intent: *"浏览器插件和移动端通过此 token 连接到桌面端"*.

**Goal:** Wire the mobile app into the existing WS host so a phone can pair via QR code, then monitor sessions, send prompts, and approve permissions — all over LAN.

### 1.1 Current State

| Capability | Status |
|---|---|
| WS host server | ✅ Done — `apps/desktop/src/main/host/` |
| Token auth (subprotocol) | ✅ Done — `host/auth.ts` |
| Symmetric RPC protocol | ✅ Done — `@swarm/protocol` (`rpc-peer.ts`, `service-client.ts`) |
| Event broadcasting to peers | ✅ Done — `host/bridge.ts` |
| Reference WS transport adapter | ✅ Done — `apps/extension/lib/transport-ws.ts` |
| LAN binding (non-loopback) | ❌ Bound to `127.0.0.1` only |
| QR code pairing | ❌ Manual token copy only |
| Mobile app integration | ❌ No `@swarm/protocol` / WS in `apps/mobile` |

### 1.2 Key Constraint

The WS host binds to `127.0.0.1` (loopback only), so a physical phone on Wi-Fi cannot reach it. Changing the bind to `0.0.0.0` is the only desktop-side change strictly required for LAN connectivity. Token auth already guards against unauthorized access.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | Reuse existing WS host | Desktop host, bridge, auth, RPC protocol all ready. Browser extension validated the path. |
| Network scope | LAN only (first phase) | Simplest; no relay infrastructure needed. Cross-network is a future phase. |
| Pairing | QR code scan | Best UX; encodes IP + port + token in one scan. |
| Concurrency | Single device | Desktop WS host already caps at 1 peer. No server-side changes needed. |
| First-phase scope | Minimal viable loop | Pair + connect + session list + message stream + send prompt + permission approval. Agent management, settings, etc. are deferred. |
| Reconnection | Manual (no auto-reconnect) | Keep first phase simple. Auto-reconnect + incremental sync is a future enhancement. |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│              Desktop (Electron)                  │
│                                                   │
│  ┌─────────────┐    ┌──────────────────────────┐ │
│  │  Service     │    │  WS Host (existing)       │ │
│  │  Process     │◄──►│  bind: 0.0.0.0:47777      │ │
│  │  (agent      │    │  auth: swarm.<token>      │ │
│  │   engine)    │    │  bridge: ConnRegistry     │ │
│  └─────────────┘    └──────────┬─────────────────┘ │
│                                │                   │
│  ┌─────────────┐    ┌──────────▼─────────────────┐ │
│  │  Renderer    │    │  Remote View (existing)     │ │
│  │  (UI)        │    │  + QR Code (NEW)            │ │
│  └─────────────┘    └────────────────────────────┘ │
└────────────────────────────────────────────────────┘
                                │ WebSocket over LAN
                                │ subprotocol: swarm.<token>
                                ▼
┌────────────────────────────────────────────────────┐
│              Mobile (Expo / RN)                     │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ QR Scan   │→ │ WS Transport │→ │ ServiceClient │  │
│  │ (camera)  │  │ Adapter      │  │ (@swarm/      │  │
│  │           │  │ (RN WS)      │  │  protocol)    │  │
│  └──────────┘  └──────────────┘  └───────┬───────┘  │
│                                          │           │
│  ┌──────────────────────────────────────▼────────┐  │
│  │            App Screens (Expo Router)           │  │
│  │  • Session List  • Session Detail (chat)       │  │
│  │  • Permission Card  • Connection Settings      │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**Data flow:** The mobile client uses `createServiceClient({ transport, onEvent })` from `@swarm/protocol` — the same facade the desktop renderer and browser extension use. It calls `ServiceMethod` RPCs (`listSessions`, `submitPrompt`, `decidePermission`, etc.) and receives `UIEvent` / `MessageWireEvent` payloads via the `onEvent` callback. The WS bridge broadcasts all `kind:'event'` messages to connected peers and routes `kind:'response'` to the requesting peer only.

---

## 4. Desktop Changes

### 4.1 WS Host Bind Address (`host/ws-server.ts`)

Change `host: '127.0.0.1'` to `host: '0.0.0.0'` so LAN devices can reach the server. Token auth (subprotocol `swarm.<token>`) already rejects unauthorized connections with `1008 'bad token'`. The single-peer cap is retained.

**Security note:** Binding `0.0.0.0` exposes the port to the local network, but:
- Connections without the 64-char hex token are rejected immediately.
- The single-peer cap means only one authorized client can be active at a time.
- Brute-forcing a 32-byte random token is infeasible.

### 4.2 LAN IP Discovery (`host/lan-ip.ts` — new file)

A small utility that enumerates network interfaces and returns the first non-internal IPv4 address:

```ts
import os from 'node:os'

export function getLanIp(): string | null {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}
```

### 4.3 WS Host Config Extension (`host/index.ts`, `main/index.ts`)

`startWsHost()` return value and the `system:getWsHostConfig` IPC handler are extended to include `lanIp`:

```ts
// Before: { port, token }
// After:  { port, token, lanIp }
```

### 4.4 QR Code in Remote View (`remote-view.tsx`)

The existing "远程连接" settings page currently shows `{port, token}` as text. Add a QR code next to it encoding:

```
swarm:<lan-ip>:<port>?token=<token>
```

Uses the `qrcode` npm package (pure JS, no native deps) to render to a `<canvas>` or base64 `<img>`.

### 4.5 Protocol Type Update (`packages/protocol/src/types/ui.ts`)

Update the `getWsHostConfig()` return type in `SwarmBridge` to include `lanIp: string | null`.

### 4.6 Desktop File Change Summary

| File | Change |
|---|---|
| `apps/desktop/src/main/host/ws-server.ts` | `host: '127.0.0.1'` → `'0.0.0.0'` |
| `apps/desktop/src/main/host/lan-ip.ts` | New file — `getLanIp()` utility |
| `apps/desktop/src/main/host/index.ts` | `startWsHost` returns `lanIp` |
| `apps/desktop/src/main/index.ts` | `getWsHostConfig` handler returns `lanIp` |
| `packages/protocol/src/types/ui.ts` | `getWsHostConfig` return type adds `lanIp` |
| `apps/desktop/src/renderer/src/components/views/remote-view.tsx` | Add QR code display |
| `apps/desktop` `package.json` | Add `qrcode` dependency |

---

## 5. Mobile App Architecture

### 5.1 New Dependencies

| Dependency | Purpose |
|---|---|
| `@swarm/protocol` (workspace) | RPC protocol, types, `createServiceClient` |
| `expo-camera` | QR code scanning |
| `@react-native-async-storage/async-storage` | Persist paired connection info (host, port, token) |

### 5.2 Directory Structure

```
apps/mobile/
├── app/                          # Expo Router routes
│   ├── _layout.tsx               # Root layout (wraps in ConnectionProvider)
│   ├── index.tsx                 # Entry: routes to pair.tsx or sessions.tsx based on connection state
│   ├── pair.tsx                  # QR scan pairing screen
│   ├── sessions.tsx              # Session list
│   ├── session/[id].tsx          # Session detail (message stream + prompt input)
│   └── settings.tsx              # Connection settings (view/disconnect/repair)
├── lib/
│   ├── transport-ws.ts           # RN WebSocket → RpcTransport adapter
│   ├── connection.ts             # Connection lifecycle: connect, disconnect, state machine
│   └── parse-qr.ts               # Parse QR content → { host, port, token }
├── stores/
│   └── connection-store.ts       # Connection state + paired config (React Context or zustand)
└── hooks/
    ├── use-service-client.ts     # Get current ServiceClient instance
    └── use-events.ts             # Subscribe to server events (message stream, permissions)
```

### 5.3 Core Modules

#### `lib/transport-ws.ts` — RN WebSocket Adapter

Ports `apps/extension/lib/transport-ws.ts` to React Native. Implements the `RpcTransport` interface (`postMessage` / `on('message')` / `off`) by wrapping RN's built-in `WebSocket`:

```ts
export function createWsTransport(url: string, token: string): RpcTransport {
  const ws = new WebSocket(url, `swarm.${token}`)
  const handlers = new Set<(msg: unknown) => void>()

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    handlers.forEach((h) => h(msg))
  }
  ws.onclose = () => { /* signal transport closed */ }
  ws.onerror = () => { /* signal transport error */ }

  return {
    postMessage: (msg) => ws.send(JSON.stringify(msg)),
    on: (handler) => handlers.add(handler),
    off: (handler) => handlers.delete(handler),
  }
}
```

#### `lib/parse-qr.ts` — QR Content Parser

Parses the `swarm:<ip>:<port>?token=<token>` URI into a structured config:

```ts
export type ConnectionConfig = { host: string; port: number; token: string }

export function parseQr(qr: string): ConnectionConfig {
  // Parse "swarm:192.168.1.100:47777?token=abc123..."
  // Returns ConnectionConfig or throws on invalid format
}
```

#### `lib/connection.ts` — Connection Manager

Responsible for:
- Accepting a `ConnectionConfig`, creating a WS transport + `ServiceClient`
- Managing connection state: `disconnected → connecting → connected → disconnected`
- Detecting disconnection via WebSocket `onclose` / `onerror`
- Persisting pairing info to AsyncStorage (auto-reconnect on next app launch)

#### `stores/connection-store.ts` — Connection State

React Context (or lightweight zustand) managing:
- `status: 'idle' | 'connecting' | 'connected' | 'error'`
- `config: ConnectionConfig | null` (saved pairing)
- `client: ServiceClient | null` (active RPC client)
- `connect(config)`, `disconnect()`, `reconnect()`

### 5.4 Screens

#### Pair Screen (`pair.tsx`)
Uses `expo-camera` for live QR scanning. On successful scan, calls `parseQr()` → `connect()` → navigates to `sessions.tsx` on success. Shows error message on failure, stays on screen for retry.

#### Session List (`sessions.tsx`)
Calls `client.listSessions()`, renders a list of `SessionSummary` using Gluestack UI components. Tapping a session navigates to `session/[id]`.

#### Session Detail (`session/[id].tsx`)
The core screen:
- Calls `client.getMessageEvents(sessionId)` to load message history
- Subscribes to `message.*` events via `use-events` hook for real-time updates
- Bottom input bar calls `client.submitPrompt(sessionId, prompt)` to send
- On `message.permission_request` event, shows a permission card with risk level, summary, and approve/deny buttons calling `client.decidePermission()`

#### Settings (`settings.tsx`)
Displays current connection info (`host:port`). Buttons: disconnect, re-pair (navigate to `pair.tsx`).

---

## 6. Data Flow

### 6.1 Session List

```
Mobile                          Desktop Service
  │                                │
  │── listSessions() ─────────────►│
  │◄── SessionSummary[] ──────────│
```

### 6.2 Session Detail + Real-time Message Stream

```
Mobile                          Desktop Service
  │                                │
  │── getMessageEvents(sessionId) ►│  (load history)
  │◄── MessageEvent[] ────────────│
  │                                │
  │   (subscribe via onEvent)      │
  │◄── message.created ────────────│  (new message)
  │◄── message.progress ───────────│  (agent thinking)
  │◄── message.tool_call ──────────│  (tool invocation)
  │◄── message.complete ───────────│  (message done)
  │◄── message.error ──────────────│  (error)
```

Events are received through the `onEvent` callback passed to `createServiceClient`. The WS bridge broadcasts all `kind:'event'` messages to connected peers (already implemented in `bridge.ts`).

### 6.3 Send Prompt

```
Mobile                          Desktop Service
  │                                │
  │── submitPrompt({               │
  │     sessionId,                 │
  │     prompt: "user input",      │
  │     ...                        │
  │   }) ─────────────────────────►│
  │◄── (returns messageId) ────────│
  │                                │
  │   (subsequent message.* events)│
  │◄── message.created ────────────│
  │◄── message.progress ───────────│
  │◄── message.complete ───────────│
```

### 6.4 Permission Approval

```
Mobile                          Desktop Service
  │                                │
  │   (agent hits medium/high risk)│
  │◄── message.permission_request ─│  {messageId, actionId, risk, summary}
  │                                │
  │   (UI: permission card shown)  │
  │   User taps "Approve"          │
  │                                │
  │── decidePermission({           │
  │     sessionId,                 │
  │     actionId,                  │
  │     decision: 'grant'          │
  │   }) ─────────────────────────►│
  │                                │  (agent continues)
  │◄── message.progress ───────────│
  │◄── message.complete ───────────│
```

### 6.5 Connection Lifecycle

```
App launch
  │
  ├─ Read saved pairing from AsyncStorage
  │   │
  │   ├─ Has pairing → auto connect()
  │   │   ├─ Success → navigate to sessions.tsx
  │   │   └─ Failure → navigate to pair.tsx (show error)
  │   │
  │   └─ No pairing → navigate to pair.tsx
  │
  └─ User scans QR
      ├─ parseQr() → connect(config)
      ├─ Success → save to AsyncStorage → navigate to sessions.tsx
      └─ Failure → show error, stay on pair.tsx
```

---

## 7. Error Handling

### 7.1 Connection Errors

| Scenario | Handling |
|---|---|
| Can't connect after scan (wrong IP / desktop not running) | Show error on pair screen, keep scanner active for retry |
| Bad token (WS 1008 'bad token') | Show "authentication failed, please re-pair", clear saved pairing |
| Another client already connected (1008 'another client is connected') | Show "desktop has an active connection, please disconnect it first" |
| Network drop (Wi-Fi switch, etc.) | WebSocket `onclose` fires → mark `disconnected` → UI shows "connection lost" with reconnect button |
| Desktop app quits | Same as above — WebSocket closes, mobile shows disconnected state |

### 7.2 Reconnection Strategy

**No auto-reconnect in the first phase.** Manual "reconnect" button only. Rationale:
- Auto-reconnect needs exponential backoff, state reconciliation (missed events during disconnect), etc.
- LAN is stable; manual reconnect is sufficient for first phase.
- Future enhancement: auto-reconnect + `getMessageEvents()` to backfill missed messages.

### 7.3 Event Loss During Disconnect

Events emitted by the desktop service while the mobile is disconnected will not arrive. On reconnect:
- Call `getMessageEvents(sessionId)` to re-fetch the full message history for the current session.
- This is a simple full-refetch strategy (no incremental sync). Sufficient for first phase.

### 7.4 Permission Request Timeout

If the user doesn't respond to a permission prompt on mobile:
- The desktop agent waits (existing behavior — desktop renderer is also async).
- The mobile permission card has no local timeout — the desktop decides timeout policy.
- If the app goes to background, the permission card state is preserved in the store and visible when the app returns to foreground.

### 7.5 QR Code / Token Security

- The QR code is only displayed in the desktop "远程连接" settings page (user must navigate there intentionally).
- The token is stored in AsyncStorage on mobile (not SecureStore — acceptable for first phase; can migrate to `expo-secure-store` later).
- The token is never logged (per project logging guidelines).

---

## 8. Testing Strategy

| Layer | Method | Coverage |
|---|---|---|
| QR parser (`parse-qr.ts`) | Unit test | Valid QR → correct `{host, port, token}`; invalid format → throws |
| WS transport adapter | Unit test (mock WebSocket) | `postMessage` sends JSON; incoming message triggers `on` callback; `onclose` signals closure |
| Connection state machine | Unit test | `idle→connecting→connected`; `connected→disconnected`; error state |
| Desktop LAN IP | Unit test (mock `os.networkInterfaces`) | Correctly filters loopback; returns null when no interfaces |
| Desktop WS bind | Integration test (extend `host.test.ts`) | External client can connect (or verify bind config) |
| End-to-end | Manual test | Phone scans QR → connects → sees session list → enters session → sends message → receives reply → approves permission |

---

## 9. Success Criteria

1. **Pairing:** Desktop "远程连接" page shows QR code → phone scans → enters session list within 5 seconds.
2. **Session list:** Phone displays the same sessions as the desktop.
3. **Message stream:** Send a message on desktop → phone receives the message event in real time.
4. **Send message:** Send a prompt on phone → message appears in desktop session → agent response streams back to phone.
5. **Permission approval:** Agent triggers a medium/high-risk action → phone shows permission card → approve → agent continues.
6. **Disconnect recovery:** Close desktop → phone shows disconnected → reopen desktop → tap reconnect on phone → connection restored.
7. **Persistence:** Kill mobile app → reopen → auto-reconnects using saved pairing info.

---

## 10. Out of Scope (Deferred)

The following are explicitly excluded from the first phase:

- ❌ Cross-network connectivity (relay/tunnel server)
- ❌ Multi-device simultaneous connection
- ❌ mDNS / Bonjour auto-discovery
- ❌ Auto-reconnect + incremental event sync
- ❌ Agent management (create/edit/delete agent configs)
- ❌ Settings sync (providers, MCP servers, etc.)
- ❌ Task board / scheduled tasks management
- ❌ SecureStore for token (first phase uses AsyncStorage)
- ❌ `wsHost.bindLan` toggle (first phase binds LAN by default)
