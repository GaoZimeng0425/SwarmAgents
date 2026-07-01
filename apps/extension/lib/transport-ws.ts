import type { ServiceTransport } from '@swarm/protocol'

// Adapt a browser WebSocket to @swarm/protocol's ServiceTransport.
// addEventListener('message') delivers MessageEvent<string>; we parse and
// forward. postMessage stringifies. `ready` resolves on the socket's open.
export function createWsTransport(ws: WebSocket): {
  transport: ServiceTransport
  ready: Promise<void>
  close: () => void
} {
  const listeners = new Set<(m: unknown) => void>()

  const onMessage = (ev: MessageEvent): void => {
    try {
      const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      listeners.forEach((fn) => fn(parsed))
    } catch {
      /* drop malformed frames */
    }
  }
  ws.addEventListener('message', onMessage as EventListener)

  const ready = new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.OPEN) resolve()
    else ws.addEventListener('open', () => resolve(), { once: true })
  })

  const transport: ServiceTransport = {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (_channel: 'message', fn: (m: unknown) => void) => listeners.add(fn),
    off: (_channel: 'message', fn: (m: unknown) => void) => listeners.delete(fn),
  }

  return { transport, ready, close: () => ws.close() }
}
