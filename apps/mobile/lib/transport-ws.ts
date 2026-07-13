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
// `onClose`, if provided, is invoked when the socket closes or errors (e.g. the
// desktop quits or Wi-Fi drops) so the caller can update connection state.
export function createWsTransport(
  config: ConnectionConfig,
  WsImpl: WebSocketLike = globalThis.WebSocket,
  onClose?: () => void
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

  // Surface socket termination to the caller so the UI can leave the `connected`
  // state when the desktop quits or the network drops. Registering both `close`
  // and `error` is safer than relying on either alone — errors usually precede
  // close, but not always.
  if (onClose) {
    ws.addEventListener('close', () => onClose())
    ws.addEventListener('error', () => onClose())
  }

  // `ready` must settle (resolve OR reject) when the socket opens or fails —
  // otherwise callers awaiting it (e.g. the auto-reconnect on launch) block
  // indefinitely if the desktop host is down, leaving the app stuck on the
  // loading screen. React Native fires `error` before `close` for a failed
  // connection; a settled flag keeps the promise from being rejected twice.
  let settled = false
  const ready = new Promise<void>((resolve, reject) => {
    if (ws.readyState === 1) {
      settled = true
      resolve()
      return
    }
    ws.addEventListener('open', () => {
      if (settled) return
      settled = true
      resolve()
    })
    ws.addEventListener('error', () => {
      if (settled) return
      settled = true
      reject(new Error('WebSocket connection failed'))
    })
    ws.addEventListener('close', () => {
      if (settled) return
      settled = true
      reject(new Error('WebSocket closed before open'))
    })
  })
  // Swallow unhandled rejections on `ready`: some callers create the transport
  // without awaiting it (e.g. the close() test, or a connect that's pre-empted
  // by a disconnect). The connection-store's doConnect always awaits it, which
  // is where the rejection actually matters.
  ready.catch(() => {})

  const transport: ServiceTransport = {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (_channel: 'message', fn: (m: unknown) => void) => listeners.add(fn),
    off: (_channel: 'message', fn: (m: unknown) => void) => listeners.delete(fn),
  }

  return { transport, ready, close: () => ws.close() }
}
