# @swarm/mobile

Expo React Native app (managed workflow). A remote client over the desktop's WS
host, same `ServiceClient`/transport shape as the extension.

## Run

```bash
pnpm --filter @swarm/mobile run start    # Expo; press i for iOS Simulator
pnpm --filter @swarm/mobile run test     # vitest (transport)
```

## Connect

1. Start the desktop (`pnpm --filter @swarm/desktop run dev`).
2. Copy the token from `~/Library/Application\ Support/SwarmAgents/ws-host.json`.
3. In the app: Settings → paste token → Save → reload → Home "test connection".

iOS Simulator's `127.0.0.1` reaches the Mac's desktop host directly. (Android
emulator would need `10.0.2.2`.)

## Status

v1 is a connection probe (`listAgents`). `submitGoal` is deferred until provider
config is exposed over WS.
