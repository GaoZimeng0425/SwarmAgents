import { type WebSocket, WebSocketServer } from 'ws'

export type WsServerLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

export type StartWsServer = {
  port: number
  token: string
  onPeer: (ws: WebSocket) => void
  log: WsServerLog
}

// Bind 0.0.0.0 so LAN devices (phone on Wi-Fi) can reach the host. The token
// travels as a Sec-WebSocket-Protocol subprotocol (swarm.<token>), never in
// URLs/logs. Multiple peers allowed (phone + browser extension); unauthorized
// connections are rejected with 1008.
export async function startWsServer(
  cfg: StartWsServer
): Promise<{ server: WebSocketServer; port: number; close: () => void }> {
  const server = new WebSocketServer({
    host: '0.0.0.0',
    port: cfg.port,
    // Accept any offered protocol; the connection handler enforces the token
    // and closes with 1008 if it's wrong. (Returning false here makes ws abort
    // the handshake with a non-deterministic close code.)
    handleProtocols: (protocols: Set<string>): string | false => Array.from(protocols)[0] ?? false,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : cfg.port
  server.on('connection', (ws, req) => {
    const offered = req.headers['sec-websocket-protocol']
    if (offered !== `swarm.${cfg.token}`) {
      cfg.log.warn({ msg: 'ws-host peer rejected: bad token' })
      ws.close(1008, 'bad token')
      return
    }
    cfg.log.info({ msg: 'ws-host peer connected', ip: req.socket.remoteAddress })
    ws.on('close', () => {
      cfg.log.info({ msg: 'ws-host peer disconnected' })
    })
    cfg.onPeer(ws)
  })
  return { server, port: boundPort, close: () => server.close() }
}
