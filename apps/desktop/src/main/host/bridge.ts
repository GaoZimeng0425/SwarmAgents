import type { ServiceTransport } from '@swarm/protocol'
import type { WebSocket } from 'ws'

export type BridgeLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

export type AttachBridge = {
  peer: WebSocket
  service: ServiceTransport
  log: BridgeLog
}

// Wire one WS peer to the service transport: peer JSON → service.postMessage;
// service 'message' → peer.send(JSON). The main serviceClient keeps its own
// 'message' handler on the same transport and simply ignores ids it didn't
// open (see service-client.ts). Heartbeat: the peer (extension SW / RN) pings;
// ws auto-answers with pong, and the host logs the ping for liveness.
//
// Only 'request'/'response'/'event' are peer-facing traffic. mainRequest/
// mainResponse are the private channel the desktop main process uses to
// answer the service's gmail.*/calendar.*/weather.* RPCs — allowlisted (not
// blocklisted) so any *future* main-only kind is excluded by default instead
// of requiring someone to remember to add it here. Forwarding them used to let
// every connected peer's own (handler-less) ServiceClient "answer" main's
// mainRequests with a bogus `no handler for <method>` mainResponse — racing,
// and usually beating, main's real (network-bound) reply for the same request
// id, since the peer's answer is a synchronous empty-Map lookup. See
// get_weather always falling back to wttr.in while the dashboard weather card
// (a different IPC channel) worked fine.
const PEER_FACING_KINDS = new Set(['request', 'response', 'event'])
const isPeerFacing = (msg: unknown): boolean => PEER_FACING_KINDS.has((msg as { kind?: string } | null)?.kind ?? '')

export function attachBridge(cfg: AttachBridge): () => void {
  const { peer, service, log } = cfg

  const onPeerMessage = (raw: unknown): void => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
      if (!isPeerFacing(msg)) return
      service.postMessage(msg)
    } catch (err) {
      log.warn({ msg: 'ws-host peer sent invalid json', err: String(err) })
    }
  }
  const onServiceMessage = (msg: unknown): void => {
    if (!isPeerFacing(msg)) return
    if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg))
  }

  peer.on('message', onPeerMessage)
  service.on('message', onServiceMessage)
  peer.on('ping', () => log.info({ msg: 'ws-host ping' }))

  log.info({ msg: 'ws-host bridge attached' })
  return () => {
    peer.off('message', onPeerMessage)
    service.off('message', onServiceMessage)
    log.info({ msg: 'ws-host bridge detached' })
  }
}
