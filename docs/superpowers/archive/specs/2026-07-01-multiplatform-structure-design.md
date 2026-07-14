# Multi-Platform Project Structure — Monorepo Migration Design

**Status:** Proposed
**Date:** 2026-07-01
**Scope:** Restructure SwarmAgents from a single Electron package into a pnpm/turbo monorepo that can host a browser extension and a React Native client alongside the existing desktop app, with the desktop app acting as the local agent-runtime host.

---

## 1. Background & Motivation

SwarmAgents is currently a single-package Electron app built with `electron-vite`. The source is already layered:

```
src/
├── main/        Electron main process entry (out/main/index.js)
├── service/     ★ agent runtime — built as a SECOND entry, runs as a Node
│                 UtilityProcess sidecar (out/main/service.js). Deeply bound
│                 to native modules: better-sqlite3, sqlite-vec, sherpa-onnx-node,
│                 @anthropic-ai/claude-agent-sdk (spawns children), child_process, fs.
├── preload/     contextBridge — exposes window.swarm to renderer
├── renderer/    React 19 UI
└── shared/      cross-process types, zod schemas, pure logic
```

Two facts make multi-platform feasible **without rewriting the agent runtime**:

1. **The main↔service boundary is already a typed RPC protocol.**
   `src/shared/types/service-ipc.ts` defines the wire protocol
   (`ServiceRequest` / `ServiceResponse` by-id match / `ServiceEvent` push / `ServiceReady`).
   `src/main/service-client.ts` defines a transport-agnostic client:

   ```typescript
   export type ServiceTransport = {
     postMessage(message: unknown): void
     on(channel: 'message', listener: (message: unknown) => void): void
     off(channel: 'message', listener: (message: unknown) => void): void
   }
   ```

   with the comment: *"Electron's UtilityProcess satisfies this structurally; tests pass a fake."*

2. **`ServiceClient` depends only on that interface.** Swap the transport for a
   WebSocket and the same client works unchanged in a browser extension or RN.

The blocker is **packaging**: everything lives in one `package.json`. The
renderer, the preload, the service sidecar, and the shared types are all built
together and cannot be imported by an external consumer. There is no way for a
browser extension or an RN app to reach `ServiceClient` or the type definitions
without copying them.

Note: `pnpm-workspace.yaml` already exists but has **no `packages:` field** — it
only gates which deps may run install scripts (`electron`, `better-sqlite3`,
`esbuild`). It is not a real workspace declaration.

### The hard constraint that shapes this design

`src/service` cannot run on a mobile device or inside an MV3 service worker
(native modules + child-process spawns + local filesystem). Therefore the
**browser extension and the RN app are remote clients by necessity**, not
standalone runtimes. The only realistic model is: a long-running host process
owns the agent runtime, and lightweight clients connect to it over the existing
RPC protocol carried over WebSocket.

Per the user's decision, that host is the **SwarmAgents desktop app**.

---

## 2. Goals

1. **Restructure into a monorepo** (`apps/*` + `packages/*`) so the protocol and
   shared pure logic are importable packages.
2. **Zero behavioral regression on desktop** — same dev/build/test, same UX.
3. **Expose the service over WebSocket** from the desktop main process, so an
   external process can drive `ServiceClient` over the loopback.
4. **Stand up a Chrome MV3 extension skeleton** that connects to the local
   desktop host, submits a goal, and observes progress.
5. **Stand up a React Native (Expo) skeleton** that does the same.
6. **Establish build orchestration** (turbo) and shared tooling (tsconfig, biome).

## 3. Non-Goals

- **No remote/cloud-hosted service.** Desktop is the only host (user decision).
- **No `agent-runtime` package.** The service stays inside `apps/desktop`; it is
  not extracted into its own package. (The protocol boundary is preserved, so
  extracting later is mechanical — see §10, Phase 8 deferred.)
- **No shared UI components across platforms.** The desktop renderer uses
  Web/electron-specific APIs (TanStack Router, `window.swarm` IPC, ScrollArea,
  electron-only deps); RN cannot consume them and the extension is deliberately
  lightweight. Only `@swarm/protocol` and `@swarm/shared` are shared.
- **No Firefox/Safari extension.** Chrome MV3 first.
- **No bare React Native.** Expo (prebuilt dev client) first.
- **No multi-tenant isolation on the host.** v1 assumes a single trusted
  external client per desktop instance (see §7.4).
- **No changes to the agent runtime's behavior.** Service code moves; it is not
  refactored.

---

## 4. Architecture

### 4.1 Target directory layout

```
swarm-agents/
├── apps/
│   ├── desktop/                       ← existing Electron project, moved wholesale
│   │   ├── electron.vite.config.ts    ← moved; aliases point into apps/desktop/src
│   │   ├── electron-builder.yml
│   │   ├── tsconfig.{json,node,web}.json
│   │   ├── vitest.config.ts
│   │   ├── biome.json                 (or inherits root — see §8.2)
│   │   ├── package.json               (electron, electron-vite, native deps, @swarm/* deps)
│   │   └── src/
│   │       ├── main/
│   │       │   ├── (existing slices: ipc, windows, providers, budgets, …)
│   │       │   ├── service-client.ts  ← thinned: types moved to @swarm/protocol;
│   │       │   │                         ServiceTransport iface re-exported from there
│   │       │   └── host/              ★ NEW — WebSocket host
│   │       │       ├── ws-server.ts   loopback WebSocketServer
│   │       │       ├── ws-transport.ts adapts a WS peer ↔ service UtilityProcess
│   │       │       ├── auth.ts        loopback + shared-token gate
│   │       │       └── index.ts       wiring (startWsHost)
│   │       ├── preload/               unchanged
│   │       ├── renderer/              unchanged (still uses window.swarm IPC)
│   │       └── service/               moved wholesale; second entry unchanged
│   │
│   ├── extension/                     ← Chrome MV3 (Vite + React)
│   │   ├── manifest.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts             (@crxjs/vite or manual multi-entry)
│   │   ├── package.json
│   │   └── src/
│   │       ├── background/            service worker: WS client (heartbeat + reconnect)
│   │       │   ├── transport-ws.ts    WebSocket → ServiceTransport
│   │       │   └── index.ts
│   │       ├── popup/                 React UI: submit goal, show progress
│   │       ├── content/               (optional) selection → goal
│   │       └── options/               host URL/token config
│   │
│   └── mobile/                        ← React Native (Expo, prebuilt dev client)
│       ├── app.config.ts
│       ├── tsconfig.json
│       ├── package.json
│       └── src/
│           ├── transport-ws.ts        RN WebSocket → ServiceTransport
│           ├── screens/               sessions / submit-goal / progress
│           └── App.tsx
│
├── packages/
│   ├── protocol/                      ★ multi-platform cornerstone — zero non-zod runtime deps
│   │   ├── package.json               name: @swarm/protocol
│   │   ├── src/
│   │   │   ├── types/                 ← moved from src/shared/types/*
│   │   │   │   ├── task.ts agent.ts ui.ts ipc.ts service-ipc.ts
│   │   │   │   ├── mcp.ts skill.ts memory.ts budgets.ts provider.ts
│   │   │   │   ├── model-role.ts permission.ts tool-toggles.ts
│   │   │   │   ├── usage.ts web-search.ts trending.ts bilibili.ts actor.ts
│   │   │   │   └── (each keeps its *.test.ts)
│   │   │   ├── schemas/               zod exports consolidated (InboundSchema, etc.)
│   │   │   ├── service-ipc.ts         ServiceMethod / ServiceRequest / Response / Event
│   │   │   ├── service-client.ts      ← moved from src/main/service-client.ts
│   │   │   │                          (ServiceClient + createServiceClient + ServiceTransport)
│   │   │   └── index.ts               barrel
│   │   └── tsconfig.json
│   │
│   └── shared/                        pure logic, no Node-native deps, no pino
│       ├── package.json               name: @swarm/shared
│       ├── src/
│       │   ├── agents/                delegation / org-tree / model-override / default-prompt
│       │   ├── constants/             agents.ts / models.ts
│       │   ├── tokens.ts
│       │   ├── events.ts              (if pure — else relocate to protocol)
│       │   ├── system-session.ts
│       │   └── index.ts
│       └── tsconfig.json
│
├── tools/
│   ├── tsconfig/                      shared tsconfig bases (node, web, rn)
│   │   ├── base.json
│   │   ├── node.json
│   │   ├── web.json
│   │   └── react-native.json
│   └── biome/                         (optional shared biome config)
│
├── pnpm-workspace.yaml                packages: [apps/*, packages/*]
├── turbo.json                         build / dev / test / lint / typecheck
├── package.json                       root workspace package
├── biome.json
├── tsconfig.json                      root solution refs
└── .npmrc
```

### 4.2 Package dependency graph (enforced, acyclic)

```
@swarm/protocol   ◄── depends on nothing but zod (compile-time types + runtime schemas)
       ▲
       │
@swarm/shared     ◄── may depend on @swarm/protocol (types), nothing else platform-bound

apps/desktop      depends on @swarm/protocol, @swarm/shared  (+ electron, native)
apps/extension    depends on @swarm/protocol                  (+ React, Vite, crxjs)
apps/mobile       depends on @swarm/protocol                  (+ expo, react-native)
```

The rule: **`@swarm/protocol` and `@swarm/shared` never import from any
`apps/*`**, and never import `electron`, `better-sqlite3`, `node:*`, etc. This
is the load-bearing invariant. §8.3 describes how it is enforced.

### 4.3 Runtime data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ apps/desktop (Electron)                                              │
│                                                                      │
│   renderer ──window.swarm──► main ──ServiceClient(utilityProc)──►    │
│                                  │                                   │
│                                  │   service sidecar (UtilityProcess)│
│                                  │   better-sqlite3 / sqlite-vec /   │
│                                  │   claude-agent-sdk / tools / mcp  │
│                                  │                                   │
│                          ★ NEW: ws host (loopback)                   │
│                                  │                                   │
└──────────────────────────────────┼───────────────────────────────────┘
                                   │ WebSocket (ServiceTransport framing)
                  ┌────────────────┴─────────────────┐
                  │                                  │
          ┌───────▼────────┐                 ┌───────▼────────┐
          │ apps/extension │                 │ apps/mobile    │
          │ (MV3 SW)       │                 │ (Expo/RN)      │
          │ ServiceClient  │                 │ ServiceClient  │
          │ (ws transport) │                 │ (ws transport) │
          └────────────────┘                 └────────────────┘
```

The desktop main process becomes a **transparent relay** for external clients:
bytes arriving on a WebSocket are forwarded to the service UtilityProcess
transport, and vice-versa. The service is unaware whether a given request
originated from the renderer or from an external WS peer — both speak the
identical `service-ipc` protocol through the identical `ServiceClient`.

---

## 5. Packages

### 5.1 `@swarm/protocol`

**Contents (moved from current locations):**
- All of `src/shared/types/*` → `packages/protocol/src/types/`
- `src/shared/types/service-ipc.ts` → `packages/protocol/src/service-ipc.ts`
- `src/main/service-client.ts` → `packages/protocol/src/service-client.ts`
  (including `ServiceTransport`, `ServiceClient`, `createServiceClient`)
- `Inbound`/`Outbound` zod schemas currently in `src/shared/types/ipc.ts` →
  `packages/protocol/src/schemas/`

**Runtime dependency:** `zod` only. This is acceptable — zod is small,
isomorphic, and already used for wire validation. Everything else in the
package is type-level (erased at compile time).

**Build:** `tsup` or `tsc` emitting ESM + types. Consumers import via the
`@swarm/protocol` subpath. The package must build **before** any app (turbo
dependency edge).

**What stays OUT:** any logic that touches Node, the DOM, React, or Electron.
The test for membership: "can an MV3 service worker and an RN Hermes bundle
both import this symbol?" If no, it does not belong here.

### 5.2 `@swarm/shared`

**Contents (pure logic moved from `src/shared/`):**
- `src/shared/agents/{delegation,org-tree,model-override,default-prompt}.ts`
- `src/shared/constants/{agents,models}.ts`
- `src/shared/tokens.ts`
- `src/shared/system-session.ts`
- `src/shared/events.ts` — **relocate decision:** if it defines protocol event
  shapes (wire messages), it goes to `@swarm/protocol`; if it is pure
  computation, it stays here. Resolve by file inspection at migration time.

**Explicitly stays in `apps/desktop`:** `src/shared/logger.ts` (uses `pino`,
which is Node-oriented). Desktop keeps pino; the extension uses `console`, RN
uses its own logger. `@swarm/shared` must not import `pino`. If shared logic
needs to emit structured events, it returns/throws values and lets the caller
log — it does not call a logger itself. (Audit during migration; refactor only
the call sites that violate this.)

**Dependency:** may depend on `@swarm/protocol` for types. Nothing else
platform-bound.

---

## 6. Apps

### 6.1 `apps/desktop`

**Migration:** move `src/`, `electron.vite.config.ts`, `electron-builder.yml`,
the three `tsconfig.*`, `vitest.config.ts`, `biome.json`, and the runtime
`dependencies` (electron, native modules, agent SDKs, all UI deps) into
`apps/desktop/`. The root `package.json` becomes the workspace root (devDeps
for turbo/biome only).

**Aliases:** `@shared`, `@main`, `@service`, `@renderer`, `@` in
`electron.vite.config.ts` continue to point at `apps/desktop/src/...`. Add
`@swarm/protocol` and `@swarm/shared` as resolved workspace packages (pnpm
symlinks them; no alias needed beyond standard resolution).

**service entry:** unchanged. `electron.vite.config.ts` still declares
`main.build.rollupOptions.input = { index, service }`, still emits
`out/main/{index,service}.js`, still inlines the ESM-only set
(`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `chokidar`). All of
that config moves verbatim.

**The `@shared/*` → `@swarm/*` import rewrite:** every existing
`import ... from '@shared/types/X'` becomes `from '@swarm/protocol'` (or a
subpath). `import ... from '@shared/agents/Y'` / `'@shared/constants/Z'` /
`'@shared/tokens'` etc. become `@swarm/shared`. Existing main-process
`import ... from '@main/service-client'` (and any relative import of that file)
become `from '@swarm/protocol'` — no desktop re-export shim; imports point
directly at the package. This is the largest mechanical surface of the migration.

**★ New: WebSocket host** (`apps/desktop/src/main/host/`):
- `ws-server.ts` — starts a `ws.WebSocketServer` bound to `127.0.0.1:<port>`.
- `ws-transport.ts` — for each connected peer, bridges the peer's messages to
  the service UtilityProcess transport (transparent relay; see §7).
- `auth.ts` — rejects non-loopback peers and peers missing the shared token.
- `index.ts` — `startWsHost({ serviceTransport, port, token })`, called from
  main's boot sequence after the service is ready.
- Port + token are written to `userData/ws-host.json` so clients can discover
  them (the extension reads a file the desktop writes, or the user pastes the
  endpoint into the extension/mobile options screen).

### 6.2 `apps/extension` (Chrome MV3)

**Stack:** Vite + React + `@crxjs/vite` (handles MV3 manifest + HMR) +
`@swarm/protocol`.

**Structure:**
- `background/` (service worker) — owns the persistent `ServiceClient`
  constructed over a `transport-ws.ts` (browser `WebSocket` →
  `ServiceTransport`). Implements:
  - **Heartbeat** — periodic `ping` so the SW is not recycled (MV3 idle GC).
  - **Reconnect** — on close/error, backoff + retry; re-issue in-flight
    requests via the pending-request map (the `ServiceClient` already keys by
    id, so reconnect can re-send or fail them).
- `popup/` — minimal React UI: a goal input, a submit button, a live
  task-event feed (subscribes to `ServiceEvent`s). Reuses
  `@swarm/protocol` types only; no desktop UI import.
- `options/` — configure host endpoint + token (stored in
  `chrome.storage.local`).
- `content/` — **stretch** for v1: send selected text as a goal.

**Verification target:** load the unpacked extension, open popup, submit a
goal, see it complete against the running desktop app.

### 6.3 `apps/mobile` (Expo / React Native)

**Stack:** Expo SDK (prebuilt dev client — `expo-prebuild`), React Native,
`@swarm/protocol`. Expo Go is insufficient if any native module is later
needed; prebuild keeps the door open without forcing bare RN now.

**Structure:**
- `transport-ws.ts` — RN's global `WebSocket` → `ServiceTransport`.
- `screens/` — Sessions list, Submit-goal, Progress (task events).
- `App.tsx` — navigation + a "host settings" screen (endpoint + token, stored
  via `expo-secure-store` or `AsyncStorage`).

**Verification target:** run in iOS simulator against the desktop host on the
same machine (`127.0.0.1:<port>`), submit a goal, see completion.

---

## 7. ServiceTransport over WebSocket

The centerpiece reuse. The `ServiceTransport` interface is unchanged:

```typescript
export type ServiceTransport = {
  postMessage(message: unknown): void
  on(channel: 'message', listener: (message: unknown) => void): void
  off(channel: 'message', listener: (message: unknown) => void): void
}
```

### 7.1 Client side (extension + mobile)

A `WebSocket` adapter implementing `ServiceTransport`:
- `postMessage(msg)` → `ws.send(JSON.stringify(msg))`
- `on('message', fn)` → `ws.onmessage = (e) => fn(JSON.parse(e.data))`
- plus connect/open/ready gating: `ServiceClient.connect()` must await the
  socket `open`. The adapter exposes a `ready` promise consumed by
  `createServiceClient({ transport })`.

### 7.2 Host side (desktop main)

The host does **not** re-implement `ServiceClient`. It relays:

```
WS peer --onMessage--> serviceUtilityTransport.postMessage(json)
serviceUtilityTransport --on('message')--> wsPeer.send(json)
```

Each connected WS peer is bridged 1:1 to the existing
UtilityProcess `ServiceTransport` that main already holds. The service sees a
second logical client on the same transport.

**Caveat — multi-client semantics (§7.4):** the service today assumes a single
client (the renderer, via main). Unprompted `ServiceEvent`s are pushed to
"the" client. With two clients sharing one transport, events would be
duplicated/mixed. v1 mitigation:

- Option A (v1, simplest): allow **one external WS peer at a time**; reject a
  second peer while one is connected. Sufficient for a single user's desktop +
  extension + phone-at-different-times.
- Option B (deferred): multiplex — tag each request with a `clientId`, have the
  service route events back to the originating client. This is the path to
  true multi-client and is the future work referenced in §10.

The chosen v1 is Option A; documented in `host/ws-server.ts`.

### 7.3 Framing & lifecycle

- Framing: one JSON object per WebSocket text frame (matches the current
  `postMessage(unknown)` model — no binary).
- Connect: peer opens WS → host checks token header/query → on accept, bridges.
- Disconnect: peer leaves → host tears down the bridge; pending external
  requests are rejected with a transport error.
- Heartbeat: client sends `{"kind":"ping"}` every ~20s; host echoes. This is
  **outside** the service-ipc protocol (intercepted by the WS layer, never
  forwarded to the service) and exists solely to keep the MV3 SW alive and to
  detect dead peers.

### 7.4 Auth model (v1)

- Bind to `127.0.0.1` only — not `0.0.0.0`. Non-loopback cannot reach it.
- Shared token: desktop generates a random token at first boot, persists to
  `userData/ws-host.json` (alongside `port`). Clients must present it in the
  WS handshake (`Sec-WebSocket-Protocol` subprotocol or a query param). No
  token → close code 4401.
- **Explicitly weak:** this stops unrelated local processes, not a determined
  local attacker. Acceptable for v1 single-user; documented as such. Real
  auth/mTLS is future work.

---

## 8. Build & Tooling

### 8.1 pnpm workspaces + turbo

- `pnpm-workspace.yaml` gains `packages: [apps/*, packages/*]`.
- `turbo.json` defines pipelines: `build` (with `dependsOn: ^build` so
  packages build before apps), `test`, `lint`, `typecheck`, `dev` (persistent).
- Root `package.json` holds turbo, pnpm, biome, typescript as devDeps; delegates
  runtime deps to each app's `package.json`.

### 8.2 TypeScript

- `tools/tsconfig/{base,node,web,react-native}.json` — shared bases.
- `@swarm/protocol` and `@swarm/shared` build with project references; apps
  reference them via `paths` or via the built package (decide per §10 Phase 2:
  start with source `paths` for fast migration, switch to built dist later if
  RN bundler needs it).
- Desktop keeps its existing `tsconfig.node.json` / `tsconfig.web.json` split.

### 8.3 Boundary enforcement

- **Manual + lint:** add an eslint rule (or a `dependency-cruiser` rule) that
  forbids `@swarm/protocol` and `@swarm/shared` from importing `electron`,
  `better-sqlite3`, `node:*`, `sherpa-onnx-node`, `@modelcontextprotocol/sdk`,
  `@anthropic-ai/*`, `react`, `react-native`, or any `apps/*` path. Run in
  `lint` pipeline. This is the structural guarantee that makes multi-platform
  real, not aspirational.

### 8.4 Biome

- A root `biome.json` with shared settings; each app may extend. Note memory
  `reference_biome_check_hardcodes_dot`: scope per-file with
  `npx biome check --write <file>`, never blanket `pnpm check` during migration.

---

## 9. Known Issues & Mitigations

| Issue | Mitigation |
|---|---|
| **pnpm + RN/metro symlink** — metro does not follow pnpm's symlinked `node_modules`, breaking RN bundling. | `apps/mobile/.npmrc` with `node-linker=hoisted` for that workspace, OR `public-hoist-pattern[]=*` + a `metro.config.js` resolver hook. Expo documents pnpm support; follow its current guidance at migration time. |
| **MV3 service-worker idle GC** — the SW is killed after ~30s idle, dropping the WS. | Heartbeat ping every ~20s (§7.3); on disconnect, reconnect with backoff and re-queue pending requests by id. |
| **`@shared/*` import rewrite is large.** | Mechanical codemod (ts-morph or a sed pass over the alias map) + `tsc` will catch misses. Do it in one commit per slice (§10). |
| **ESM-only deps in service bundle** (`pi-agent-core`, `pi-ai`, `chokidar`) — already special-cased in `electron.vite.config.ts`. | Move that config block verbatim into `apps/desktop/`. Do not refactor. |
| **`postinstall` (`install-electron` + `electron-builder install-app-deps`)** — must run in `apps/desktop`, not root. | Move script to `apps/desktop/package.json`; root `postinstall` runs `pnpm -r install`-style lifecycle if needed. Memory `project_electron_binary_install` documents the `pnpm exec install-electron` fix — preserve it. |
| **Tests run through Electron's node** (memory `project_run_tests_via_electron_node`) — `npm test`, never bare vitest. | Desktop test script moves with the app. Protocol/shared tests are pure-node and can run under plain vitest, but to avoid drift, run everything via the workspace `test` pipeline and let desktop keep its Electron-node runner. |
| **`better-sqlite3` ABI** (memory `project_run_tests_via_electron_node` — never `pnpm rebuild`). | `apps/desktop` keeps `postinstall: install-electron && electron-builder install-app-deps`. |

---

## 10. Migration Plan (phased, each phase independently verifiable)

> Each phase is a merge commit on its own. If a phase fails verification, it
> does not merge. This keeps `develop` green and lets parallel work continue.

**Phase 1 — Monorepo skeleton + desktop move (no behavior change).**
Create `apps/desktop`, `packages/`, `tools/`, root `turbo.json`, rewrite
`pnpm-workspace.yaml`. Move the entire existing project into `apps/desktop/`
verbatim. Adjust aliases. Desktop dev/build/test/typecheck green.
→ **Verify:** `pnpm --filter desktop dev` launches; `pnpm --filter desktop
test` passes the existing suite; `pnpm --filter desktop build` produces
`out/main/{index,service}.js`; manual smoke (open app, run one agent task).

**Phase 2 — Extract `@swarm/protocol`.**
Move `src/shared/types/*`, `service-ipc.ts`, and `src/main/service-client.ts`
into `packages/protocol`. Rewrite all `@shared/types/*` imports across the
repo to `@swarm/protocol`. Add the boundary lint rule (§8.3).
→ **Verify:** `pnpm --filter @swarm/protocol build` succeeds; desktop
typecheck + tests green; boundary lint clean.

**Phase 3 — Extract `@swarm/shared`.**
Move pure logic (`agents/`, `constants/`, `tokens`, `system-session`, `events`
per the relocate decision). Rewrite imports. Audit & relocate any `pino` use
out of shared.
→ **Verify:** `@swarm/shared` builds; desktop green; boundary lint clean.

**Phase 4 — WebSocket host in desktop.**
Implement `apps/desktop/src/main/host/`. Wire `startWsHost` into main boot.
Write a node-level integration test: a script in `apps/desktop` that builds a
`ServiceClient` over a WS transport pointed at the running host and calls
`listAgents()` / `listSessions()` end-to-end.
→ **Verify:** that script returns real data; `userData/ws-host.json` is
written; a peer without the token is rejected.

**Phase 5 — `apps/extension` skeleton.**
Scaffold MV3 (Vite + crxjs + React). Background WS client with heartbeat +
reconnect. Popup: submit goal + event feed. Options: endpoint/token.
→ **Verify:** load unpacked extension; popup submits a goal to the running
desktop; events stream back; goal completes.

**Phase 6 — `apps/mobile` skeleton.**
Scaffold Expo (prebuild). WS transport. Three screens.
→ **Verify:** iOS simulator submits a goal to the desktop host; completes.

**Phase 7 — Turbo + docs.**
Finalize `turbo.json` pipelines; root README updates; per-app READMEs. A
top-level `pnpm dev` that brings up desktop (and only desktop — extension/mobile
have their own launch).
→ **Verify:** `turbo run build && turbo run test && turbo run typecheck` green
from root.

**Phase 8 (DEFERRED — not in this spec's deliverable).**
Extract `src/service` into `packages/agent-runtime` and `transport-ws` into
`packages/transport-ws`, enabling a standalone host deploy. Only do this when a
remote/cloud host is actually wanted. The protocol boundary preserved here
makes it mechanical.

---

## 11. Regression & Acceptance Criteria

The migration succeeds when **all** hold:

1. **Desktop zero-regression:** existing `vitest` suite passes unchanged; desktop
   `typecheck` clean; `electron-vite build` succeeds; manual agent-task run
   works as before.
2. **Package boundaries:** `@swarm/protocol` and `@swarm/shared` build
   independently; boundary lint (§8.3) is clean; neither package imports any
   platform-bound symbol.
3. **External reachability:** a non-Electron process can construct
   `ServiceClient` over WS and successfully invoke `listAgents`,
   `listSessions`, `submitGoal`, and receive `ServiceEvent`s — proven by the
   Phase 4 integration test.
4. **Extension:** loads as unpacked MV3, submits a goal, observes completion.
5. **Mobile:** runs in iOS simulator, submits a goal, observes completion.
6. **Orchestration:** `turbo run build/test/typecheck` green from root.

---

## 12. Test Strategy

- **`@swarm/protocol`:** existing schema/client unit tests move with the code.
  The `service-client.test.ts` pattern (fake transport) already covers the RPC
  matching logic — keep it, add a WS-transport fake variant.
- **WS host:** a loopback integration test (Phase 4) — start the host in-process
  against a fake service transport, connect a real `ws` client, assert
  request/response round-trip and token rejection.
- **Extension/Mobile:** manual verification per Phase 5/6 (no automated
  cross-app e2e in scope; the shared integration test in Phase 4 is the
  contract).

---

## 13. Risks

- **Largest risk: the import rewrite.** `@shared/*` is used pervasively across
  main, service, renderer, and tests. A missed alias silently breaks types.
  Mitigation: codemod + `tsc --noEmit` gate per phase; never merge a phase
  with type errors.
- **pnpm↔RN/metro friction** may surface Expo-specific breakage. Mitigation:
  Phase 6 is isolated; if RN bundling blocks on symlinks, fall back to
  `node-linker=hoisted` scoped to `apps/mobile` (§9).
- **MV3 SW lifecycle** can make the extension feel flaky. Mitigation: heartbeat
  + reconnect from day one (§7.3); do not ship without it.
- **Parallel work on `develop`.** This migration touches nearly every file.
  Mitigation: do it in a dedicated branch/worktree; land phases incrementally;
  freeze conflicting service/renderer changes during the move window, or
  rebase them onto the new structure.

---

## 14. Open Questions (resolve before/during implementation)

1. **Port discovery:** fixed port (e.g. 47777) vs. dynamic + `userData/ws-host.json`.
   Recommend dynamic + file (avoids port collisions); extension/mobile read the
   file or accept manual entry.
2. **`events.ts` ownership** — protocol or shared? Decide by file inspection
   at Phase 3.
3. **Token transport** — subprotocol vs. query param. Recommend subprotocol
   (`Sec-WebSocket-Protocol: swarm.<token>`) so it is not logged in URLs.
4. **Shared tsconfig strategy** — source `paths` vs. built dist for consuming
   `@swarm/*`. Recommend source paths initially (faster), revisit if a
   consumer's bundler (metro/crxjs) requires dist.
