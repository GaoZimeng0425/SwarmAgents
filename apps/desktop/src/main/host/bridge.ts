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
export function attachBridge(cfg: AttachBridge): () => void {
  const { peer, service, log } = cfg

  const onPeerMessage = (raw: unknown): void => {
    try {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw))
      service.postMessage(msg)
    } catch (err) {
      log.warn({ msg: 'ws-host peer sent invalid json', err: String(err) })
    }
  }
  const onServiceMessage = (msg: unknown): void => {
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
