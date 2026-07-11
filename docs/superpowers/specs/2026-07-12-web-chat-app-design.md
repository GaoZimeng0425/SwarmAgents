# Web Chat App Design

> A browser-based chat client for the SwarmAgents desktop host. This spec covers
> the MVP scope only.

## Goal

Build a new `apps/web` package: a Vite + React SPA that connects to the existing
desktop Electron WS host as a third WS peer (alongside the mobile app and
browser extension), letting the user pick a session, send prompts, read
streaming replies, and approve permission requests — entirely in the browser.

No desktop-side changes are required. The WS host already binds `0.0.0.0`,
supports multiple peers, and authenticates via a `Sec-WebSocket-Protocol:
swarm.<token>` subprotocol.

## Non-Goals (MVP)

- Auto-reconnect on socket drop (manual reconnect only).
- Persisting connection info across reloads (re-enter host/port/token each run).
- Settings panels beyond connection management (no agents / skills / MCP /
  budgets / weather).
- History search, deep markdown rendering (plain text first).
- Dark mode toggle (inherit `@swarm/ui` defaults).

## Architecture

```
Browser (apps/web)
  └─ User enters host:port:token
     └─ new WebSocket(`ws://${host}:${port}`, `swarm.${token}`)
        └─ createWsTransport(ws) → ServiceTransport
           └─ createServiceClient({ transport, onEvent })
              ├─ RPC: listSessions / getMessageEvents / submitPrompt / decidePermission
              └─ Events: onEvent → module-level eventEmitter → useEvents hook
```

The web app is architecturally a peer of the mobile app: same transport
abstraction, same connection-store shape, same event-emitter pattern. The only
difference is the UI layer (browser DOM + `@swarm/ui` instead of React Native
+ Gluestack) and the connection entry (manual form instead of QR scan).

### Correspondence with the mobile app

| mobile | web |
|---|---|
| `lib/transport-ws.ts` | `lib/transport-ws.ts` (identical browser-WebSocket logic) |
| `stores/connection-store.tsx` | `stores/connection-store.tsx` (isomorphic Context) |
| `hooks/use-events.ts` | `hooks/use-events.ts` (isomorphic emitter) |
| `app/pair.tsx` (QR scan) | `pages/connect.tsx` (manual input form) |
| `app/sessions.tsx` | `pages/sessions.tsx` + TanStack Query |
| `app/session/[id].tsx` | `pages/session.tsx` + TanStack Query + streaming |
| `app/settings.tsx` | `pages/settings.tsx` |

## Tech Stack

- **Vite + React 19 + TypeScript** — SPA shell, path alias `@` → `./src`.
- **`@swarm/ui`** (`workspace:*`) — shadcn / Tailwind v4 component library.
- **`@swarm/protocol`** (`workspace:*`) — `ServiceClient`, `ServiceTransport`,
  `createServiceClient`, message-event types.
- **`@tanstack/react-query`** (added to `pnpm-workspace.yaml` catalog) — wraps
  `listSessions()` and `getMessageEvents(id)` for cache + invalidation; matches
  the desktop renderer's state-management choice.
- **`react-router-dom`** — SPA routing.
- **`@tailwindcss/vite`** (catalog) — Tailwind v4 build, same as `@swarm/ui`.

## File Structure

```
apps/web/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts            # @tailwindcss/vite + path alias @ → ./src
├── src/
│   ├── main.tsx              # mount React + QueryClientProvider + ConnectionProvider
│   ├── App.tsx               # react-router routes: /connect /sessions /session/:id /settings
│   ├── global.css            # @swarm/ui styles + tailwind
│   ├── lib/
│   │   ├── transport-ws.ts   # createWsTransport(ws) — browser WebSocket → ServiceTransport
│   │   └── parse-config.ts   # parse + validate user-entered host:port:token
│   ├── stores/
│   │   └── connection-store.tsx  # ConnectionProvider + useConnection() + eventEmitter
│   ├── hooks/
│   │   ├── use-events.ts     # useEvents(filter) — subscribe to eventEmitter
│   │   └── use-sessions.ts   # useSessions() — TanStack Query wrapper over listSessions()
│   ├── pages/
│   │   ├── connect.tsx       # connection form: host/port/token → connect()
│   │   ├── sessions.tsx      # session list (useSessions) + settings entry
│   │   ├── session.tsx       # session detail: history + streaming + input + permission cards
│   │   └── settings.tsx      # connection status / disconnect / reconnect
│   └── components/
│       ├── message-bubble.tsx  # render one message (created/progress/complete/error/permission)
│       └── permission-card.tsx # permission approval card (grant / deny)
```

## Data Flow

### Connection lifecycle (`connection-store.tsx`)

```
connect(cfg)
  → status='connecting', error=null
  → const ws = new WebSocket(`ws://${host}:${port}`, `swarm.${token}`)
  → const { transport, ready, close } = createWsTransport(ws)
  → const sc = createServiceClient({ transport, onEvent: (e,d) => eventEmitter.emit(e,d) })
  → await ready              // socket open
  → await sc.connect()       // rpc peer attaches its message listener
  → status='connected', store ws/sc/closeRef/clientRef/configRef
  → catch → status='error', error=msg, clear refs

disconnect()
  → sc.disconnect()          // rpc peer: reject pending + off listener
  → closeRef()               // ws.close()
  → status='idle', clear client/config

reconnect()
  → disconnect() then connect(configRef.current)
```

Socket `close`/`error` events set `status='error'`. `session.tsx` and other
authenticated pages redirect to `/connect` when `status !== 'connected'`. No
automatic reconnect.

### RPC calls (TanStack Query)

| Call | Wrapper | Cache strategy |
|---|---|---|
| `listSessions()` | `useSessions()` = `useQuery` | staleTime 30s + manual invalidate (e.g. after creating a session) |
| `getMessageEvents(id)` | `useMessageEvents(id)` = `useQuery` | fetched once on mount (staleTime Infinity); incrementals come from events |
| `submitPrompt(id, text)` | `useMutation` | no history invalidate (delta arrives via events) |
| `decidePermission(id, actionId, decision)` | direct `client.decidePermission()` | no cache |

All queries carry `enabled: !!client` so they pause when disconnected.

### Events → UI incremental stream (`session.tsx`)

```
history (TanStack Query, once) ──┐
                                 ├─→ merged message list
live events (useEvents) ─────────┘
```

- `useEvents(e => e.startsWith('message.'))` subscribes to this session's
  message events.
- Received events are dispatched by `kind`:
  - `message.created` → new user-prompt bubble
  - `message.progress` → update the corresponding message's progress (thinking / tool)
  - `message.complete` → mark the message complete
  - `message.error` → error bubble
  - `message.permission_request` → extracted into `permissions` state, rendered as `PermissionCard`
- Events whose `wireEvent.sessionId !== sessionId` are dropped.

### Message deduplication

Live events can overlap with the tail of history (events that arrived in the
instant between the history fetch and the live subscription). The merged list
keys entries by `${messageId}:${seq}` and dedupes on that key.

### Connection info lifetime

In-memory only. A page reload returns the user to `/connect` to re-enter
host/port/token. No localStorage, no cookies.

## Error Handling

| Scenario | Symptom | Handling |
|---|---|---|
| Wrong token | ws closes immediately (code 1008) | `connect()` catch → `status='error'`, "token 无效或被拒绝" |
| Host unreachable | ws `onerror`/`onclose` | `status='error'`, "无法连接到 <host:port>" |
| RPC call fails | `client.xxx()` rejects | TanStack Query `error` state → error bar + retry button |
| Socket drops mid-session | ws `onclose` | `status='error'` → auto redirect to `/connect`, "连接已断开" |
| Permission approval fails | `decidePermission` rejects | card stays; show error at top; do not navigate |
| Form validation | host/port/token empty, port non-numeric | disable submit button; no round-trip |

## Testing

Pure logic is unit-tested with Vitest; UI interaction is manually verified
(consistent with the mobile app).

| Test file | Covers |
|---|---|
| `lib/__tests__/parse-config.test.ts` | `parseConnectionConfig`: valid input parses; empty fields / port out of range / malformed format throw |
| `lib/__tests__/transport-ws.test.ts` | `createWsTransport`: token as subprotocol, `postMessage` serialization, `on`/`off` add/remove, `close` closes underlying ws (Mock WebSocket, same shape as mobile tests) |
| `hooks/__tests__/use-events.test.ts` | `eventEmitter`: specific-event subscription, `'*'` wildcard, unsubscribe stops delivery (directly testing the emitter, isomorphic to mobile) |

Not unit-tested (YAGNI): React component rendering, TanStack Query integration,
route transitions. Covered by manual E2E.

### Manual E2E checklist (implementation tail)

1. Desktop `pnpm dev`; confirm WS host is up.
2. `apps/web` `pnpm dev`; open in browser; enter host/port/token → connects,
   lands on session list.
3. Open a session, send a message → see streaming reply.
4. Trigger a permission-gated action → card appears → grant → agent continues.
5. Stop the desktop app → web shows error → restart desktop → manual reconnect.

## Conventions

- Package manager: **pnpm**; workspace deps via `workspace:*`, shared versions
  via `catalog:`.
- Code comments and commit messages: **English**. Conversation replies:
  Chinese.
- `@swarm/protocol` is logger-free; the web app uses `console` (no pino).
- The token is a secret: **never in a URL query string, never logged**. It
  travels only as `Sec-WebSocket-Protocol: swarm.<token>` (matching the host's
  auth check in `ws-server.ts`).
- Respect `tools/check-boundaries.mjs` package-boundary rules; do not import
  across `apps/*` packages.
- Biome formatting (`pnpm format` / `pnpm check`) applies to the new package.
- Path alias `@` → `./src` (mirrors mobile's `@` → `./` convention, adjusted
  for the web `src/` root).

## New catalog dependency

`@tanstack/react-query` is added to `pnpm-workspace.yaml` `catalog:` so the web
app and the desktop renderer share one pinned version.
