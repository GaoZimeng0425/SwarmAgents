# swarm-agents

A multi-platform monorepo: an Electron desktop app that owns the agent runtime,
plus a Chrome extension and a React Native client that drive it over a
loopback WebSocket.

```
apps/
├── desktop/     Electron — the agent-runtime host (main + service sidecar + renderer) + WS host
├── extension/   Chrome MV3 (WXT) — remote client over WS
└── mobile/      Expo React Native — remote client over WS
packages/
├── protocol/    @swarm/protocol — wire types + ServiceClient/ServiceTransport (zod-only)
└── shared/      @swarm/shared — platform-neutral pure logic (agents/constants/tokens)
tools/           shared tsconfig bases + check-boundaries.mjs
```

The extension and RN app cannot run the agent runtime (it needs native modules
+ child-process spawns), so both are **remote clients**: they connect to the
desktop app's loopback WS host and drive the same `ServiceClient` from
`@swarm/protocol`.

## Quick start

```bash
pnpm install
pnpm dev          # starts the desktop app (Electron)
```

The desktop opens a loopback WS server on `127.0.0.1:47777`; its port + token
are written to `~/Library/Application Support/SwarmAgents/ws-host.json`
(macOS) for the extension/RN to read.

## Per-app workflows

| App | Command | Notes |
|---|---|---|
| desktop | `pnpm --filter @swarm/desktop run dev` | Electron host |
| extension | `pnpm --filter @swarm/extension run build` | load `apps/extension/.output/chrome-mv3` unpacked in Chrome |
| mobile | `pnpm --filter @swarm/mobile run start` | Expo; press `i` for iOS Simulator |

For the extension/RN, paste the token from `ws-host.json` into their settings,
then "test connection" (lists agents from the desktop service).

## Scripts

- `pnpm verify` — typecheck + test + package-boundary check (the green bar).
- `pnpm lint` — biome lint (separate; desktop has pre-existing lint debt to clear).
- `pnpm build` / `pnpm test` / `pnpm typecheck` — turbo-fanned to every app.
- `pnpm check-boundaries` — enforce that `@swarm/protocol` and `@swarm/shared`
  import nothing platform-bound (no Node/electron/react/native).

## Status (v1)

- Desktop is the only agent-runtime host. Extension/RN are connection probes
  (`listAgents`) in v1 — `submitGoal` needs a `ProviderInjection` the clients
  don't own; exposing provider config over WS is future work.
- Single external WS peer at a time (the host rejects a second).

See `docs/superpowers/specs/2026-07-01-multiplatform-structure-design.md` for
the full design.
