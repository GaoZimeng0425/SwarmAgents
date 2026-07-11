import type { ServiceTransport } from '@swarm/protocol'
import type { WebSocket } from 'ws'

export type BridgeLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

// Tracks which WS peer originated each in-flight request id, keyed by the
// connId prefix every RpcPeer stamps onto its own ids (see rpc-peer.ts:
// `${connId}:${counter}`). Shared across every peer connection on one
// startWsHost instance so a response is routed to exactly the peer that
// asked for it — never broadcast, never delivered to the wrong peer.
export type ConnRegistry = {
  // Returns false when the connId already belongs to a DIFFERENT live peer —
  // granting it would route that peer's responses to the claimant (response
  // hijacking). A claim over a closed/stale owner succeeds: that's a peer
  // reconnecting before its old socket's close event was processed.
  claim(connId: string, peer: WebSocket): boolean
  ownerOf(connId: string): WebSocket | undefined
  release(peer: WebSocket): void
}

export function createConnRegistry(): ConnRegistry {
  const byConnId = new Map<string, WebSocket>()
  return {
    claim(connId, peer) {
      const owner = byConnId.get(connId)
      if (owner && owner !== peer && owner.readyState === owner.OPEN) return false
      byConnId.set(connId, peer)
      return true
    },
    ownerOf(connId) {
      return byConnId.get(connId)
    },
    release(peer) {
      for (const [connId, owner] of byConnId) {
        if (owner === peer) byConnId.delete(connId)
      }
    },
  }
}

export type AttachBridge = {
  peer: WebSocket
  service: ServiceTransport
  log: BridgeLog
  registry: ConnRegistry
}

const connIdOf = (id: unknown): string | null => {
  if (typeof id !== 'string') return null
  const i = id.indexOf(':')
  return i < 0 ? null : id.slice(0, i)
}

// Wire one WS peer to the service transport, with per-connection routing
// instead of a broadcast:
//   peer -> service: only 'request' messages are forwarded (peers only ever
//     ask for things); the connId in the request's id is claimed for this peer.
//   service -> peer: 'event' is broadcast to every connected peer (nobody
//     asked for it specifically; everybody who cares should see it).
//     'response' is sent ONLY to the peer that claimed the matching connId —
//     if no peer claimed it (it answers a request main itself made, or an
//     internal gmail.*/calendar.*/weather.* call the service made to main),
//     no peer ever sees it. A bare 'request' emitted BY the service (never by
//     a peer, since peers only ever initiate 'request') is always such an
//     internal main-only call, and is never forwarded either.
// Heartbeat: the peer (extension SW / RN) pings; ws auto-answers with pong,
// and the host logs the ping for liveness.
export function attachBridge(cfg: AttachBridge): () => void {
  const { peer, service, log, registry } = cfg

  const onPeerMessage = (raw: unknown): void => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
      const kind = (msg as { kind?: string }).kind
      if (kind !== 'request') return
      const id = (msg as { id?: unknown }).id
      const connId = connIdOf(id)
      if (!connId) {
        // No connId prefix means the response could never be routed back —
        // dispatching would silently hang the caller. Refuse loudly instead.
        log.warn({ msg: 'ws-host request dropped: id has no connId prefix', id })
        return
      }
      if (!registry.claim(connId, peer)) {
        log.warn({ msg: 'ws-host request dropped: connId already claimed by another peer', connId })
        return
      }
      service.postMessage(msg)
    } catch (err) {
      log.warn({ msg: 'ws-host peer sent invalid json', err: String(err) })
    }
  }
  const onServiceMessage = (msg: unknown): void => {
    const m = msg as { kind?: string; id?: unknown }
    if (m.kind === 'event') {
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg))
      return
    }
    if (m.kind === 'response') {
      const connId = connIdOf(m.id)
      if (connId && registry.ownerOf(connId) === peer && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify(msg))
      }
    }
    // 'request' (service calling main) and 'ready' never reach any peer.
  }

  peer.on('message', onPeerMessage)
  service.on('message', onServiceMessage)
  peer.on('ping', () => log.info({ msg: 'ws-host ping' }))

  log.info({ msg: 'ws-host bridge attached' })
  return () => {
    peer.off('message', onPeerMessage)
    service.off('message', onServiceMessage)
    registry.release(peer)
    log.info({ msg: 'ws-host bridge detached' })
  }
}
