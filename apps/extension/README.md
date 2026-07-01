# @swarm/extension

Chrome MV3 extension (built with WXT). A remote client that connects to the
desktop's WS host and drives `@swarm/protocol`'s `ServiceClient` over a
browser-WebSocket transport.

## Build

```bash
pnpm --filter @swarm/extension run build    # → .output/chrome-mv3/
```

## Load

1. Start the desktop (`pnpm --filter @swarm/desktop run dev`).
2. `cat ~/Library/Application\ Support/SwarmAgents/ws-host.json` — copy the token.
3. Chrome → `chrome://extensions` → Developer mode → Load unpacked → select
   `apps/extension/.output/chrome-mv3`.
4. Extension Options → paste token → Save.
5. Popup → "test connection" → shows the desktop's agent count.

## Status

v1 is a connection probe (`listAgents`). `submitGoal` is deferred until provider
config is exposed over WS.
