// Wire protocol for the Main <-> Service utilityProcess channel, and (via the
// WS bridge) for external peers <-> Service. One symmetric request/response
// pair: whoever registers a handler for a method answers it, regardless of
// which side initiated the connection or which side is calling. `id` is a
// string, not a number: it's prefixed per RpcPeer instance (see rpc-peer.ts)
// so ids never collide across main's own peer and any number of WS-bridged
// external peers sharing the same service transport — each numbers its own
// requests from 1 independently.

// The method unions now live in the single-source table (service-methods.ts);
// re-exported here so existing imports keep working.
export type { MainMethod, ServiceMethod } from '../service-methods'

import type { MainMethod, ServiceMethod } from '../service-methods'

export type RpcMethod = ServiceMethod | MainMethod

export type RpcRequest = {
  kind: 'request'
  id: string
  method: RpcMethod
  args: unknown[]
}

export type RpcResponse =
  | { kind: 'response'; id: string; ok: true; result: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }

export type RpcEvent = {
  kind: 'event'
  event: string
  data: unknown
}

export type RpcReady = { kind: 'ready' }

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent | RpcReady
