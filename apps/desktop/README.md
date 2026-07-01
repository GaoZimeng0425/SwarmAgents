# @swarm/desktop

The Electron host. Owns the agent runtime (a Node `utilityProcess` sidecar under
`src/service/` — `better-sqlite3`, `sqlite-vec`, `claude-agent-sdk`) and exposes
it to remote clients over a loopback WebSocket.

## Run

```bash
pnpm --filter @swarm/desktop run dev     # electron-vite dev
pnpm --filter @swarm/desktop run build   # typecheck + electron-vite build
pnpm --filter @swarm/desktop run test    # vitest (through Electron's node)
```

## WS host

On boot the main process starts `ws.WebSocketServer` on `127.0.0.1:47777`
(`src/main/host/`). Port + a random token are persisted to
`userData/ws-host.json`; remote clients (extension/RN) authenticate with the
token as a `Sec-WebSocket-Protocol` subprotocol (`swarm.<token>`). v1 allows
one external peer at a time.

See the repo root README for the overall architecture.
