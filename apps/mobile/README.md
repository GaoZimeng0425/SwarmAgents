# @swarm/mobile

Expo Router (React Native) client. A remote client that connects to the
desktop's WS host and drives `@swarm/protocol`'s `ServiceClient` over a
browser-WebSocket transport.

## Run

```bash
pnpm --filter @swarm/mobile run start     # Expo dev server
```

## Connect

1. Start the desktop (`pnpm --filter @swarm/desktop run dev`).
2. Copy the pairing QR code from the desktop's remote-connection panel.
3. Open the mobile app → scan the QR code to pair.

See the repo root README for the overall architecture.
