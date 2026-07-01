import type { ServiceTransport } from '@swarm/protocol'

// RN's global WebSocket is DOM-event-compatible (addEventListener/message),
// so this is the same adapter shape as the browser extension's.
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
