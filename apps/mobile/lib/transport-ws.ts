import type { ServiceTransport } from '@swarm/protocol'

import type { ConnectionConfig } from './parse-qr'

// The global WebSocket constructor. In RN this is the built-in; in tests we
// inject a mock. Declared loosely so either shape is accepted.
type WebSocketLike = {
  new (url: string, protocols?: string | string[]): unknown
}

// Adapt a React Native WebSocket to @swarm/protocol's ServiceTransport.
// The token is passed as a Sec-WebSocket-Protocol subprotocol (swarm.<token>),
// matching the desktop WS host's auth check. `ready` resolves on socket open.
export function createWsTransport(
  config: ConnectionConfig,
  WsImpl: WebSocketLike = globalThis.WebSocket
): {
  transport: ServiceTransport
  ready: Promise<void>
  close: () => void
} {
  const url = `ws://${config.host}:${config.port}`
  const protocol = `swarm.${config.token}`
  const ws = new WsImpl(url, protocol) as {
    readyState: number
    addEventListener: (event: string, fn: (...args: unknown[]) => void) => void
    send: (data: string) => void
    close: () => void
  }

  const listeners = new Set<(m: unknown) => void>()

  const onMessage = (ev: { data?: unknown }): void => {
    try {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
      const parsed = JSON.parse(raw)
      listeners.forEach((fn) => {
        fn(parsed)
      })
    } catch {
      /* drop malformed frames */
    }
  }

  ws.addEventListener('message', onMessage as (...args: unknown[]) => void)

  const ready = new Promise<void>((resolve) => {
    // readyState 1 = OPEN
    if (ws.readyState === 1) resolve()
    else ws.addEventListener('open', () => resolve())
  })

  const transport: ServiceTransport = {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (_channel: 'message', fn: (m: unknown) => void) => listeners.add(fn),
    off: (_channel: 'message', fn: (m: unknown) => void) => listeners.delete(fn),
  }

  return { transport, ready, close: () => ws.close() }
}
