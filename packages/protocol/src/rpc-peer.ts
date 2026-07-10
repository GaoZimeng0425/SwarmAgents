// Symmetric request/response/event peer over a duplex message transport.
// Both ends of a channel (main<->service, or an external peer<->service over
// the WS bridge) instantiate one of these: either side can call() a method
// the other side registered via registerHandler(), and receives unsolicited
// event pushes via onEvent. There is no fixed "client" or "server" role —
// whoever registers a handler for a method answers it, regardless of which
// side initiated the underlying connection.
export type RpcTransport = {
  postMessage(message: unknown): void
  on(channel: 'message', listener: (message: unknown) => void): void
  off(channel: 'message', listener: (message: unknown) => void): void
}

export type RpcMessage =
  | { kind: 'request'; id: string; method: string; args: unknown[] }
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }
  | { kind: 'event'; event: string; data: unknown }
  | { kind: 'ready' }

export type RpcHandler = (...args: unknown[]) => Promise<unknown> | unknown

export type RpcPeerConfig = {
  transport: RpcTransport
  onEvent?: (event: string, data: unknown) => void
  // Fallback invoked when no per-method handler was registered via
  // registerHandler. Lets a side with a large existing method table (the
  // service process's ~50 ServiceMethods) plug in as one function instead of
  // calling registerHandler once per method. Receives the request id too, so
  // callers can log/correlate exactly like the old per-request dispatcher did.
  defaultHandler?: (method: string, args: unknown[], id: string) => Promise<unknown> | unknown
}

export type RpcPeer = {
  connect(): Promise<void>
  disconnect(): void
  call<T>(method: string, args: unknown[]): Promise<T>
  registerHandler(method: string, fn: RpcHandler): void
}

// Every peer instance numbers its own outbound calls from 1, but replies
// broadcast over a transport that may be shared with other peers (see
// bridge.ts) — so a bare number can collide between two different callers'
// in-flight requests. Prefixing with a per-instance random tag makes ids
// collision-free without requiring any caller to know who else shares the
// channel.
const randomConnId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function createRpcPeer(cfg: RpcPeerConfig): RpcPeer {
  const { transport, onEvent, defaultHandler } = cfg
  const connId = randomConnId()
  let nextId = 1
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const handlers = new Map<string, RpcHandler>()
  let listener: ((message: unknown) => void) | null = null

  const respond = (id: string, work: Promise<unknown>): void => {
    work.then(
      (result) => transport.postMessage({ kind: 'response', id, ok: true, result }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        transport.postMessage({ kind: 'response', id, ok: false, error: message })
      }
    )
  }

  const handle = (message: unknown): void => {
    const msg = message as RpcMessage
    if (msg.kind === 'response') {
      const p = pending.get(msg.id)
      if (!p) return // foreign id — another peer's in-flight call sharing this transport. Drop.
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      onEvent?.(msg.event, msg.data)
    } else if (msg.kind === 'request') {
      const handler = handlers.get(msg.method)
      const work = handler
        ? Promise.resolve().then(() => handler(...msg.args))
        : defaultHandler
          ? Promise.resolve().then(() => defaultHandler(msg.method, msg.args, msg.id))
          : Promise.reject(new Error(`no handler for ${msg.method}`))
      respond(msg.id, work)
    }
  }

  return {
    connect() {
      listener = handle
      transport.on('message', listener)
      return Promise.resolve()
    },
    disconnect() {
      if (listener) transport.off('message', listener)
      listener = null
    },
    call<T>(method: string, args: unknown[]): Promise<T> {
      const id = `${connId}:${nextId++}`
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        transport.postMessage({ kind: 'request', id, method, args })
      })
    },
    registerHandler(method, fn) {
      handlers.set(method, fn)
    },
  }
}
