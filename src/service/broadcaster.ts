// Fans task/session events out to a single sink. Under utilityProcess that
// sink is `parentPort.postMessage`; in tests it's a spy. Replaces the old
// SSE-client-set broadcaster — there is exactly one consumer (the parent),
// so no client registry is needed.

export type EventSink = (event: string, data: unknown) => void

export type Broadcaster = {
  broadcast(event: string, data: unknown): void
}

export function createBroadcaster(sink: EventSink = () => {}): Broadcaster {
  return {
    broadcast(event, data) {
      sink(event, data)
    },
  }
}
