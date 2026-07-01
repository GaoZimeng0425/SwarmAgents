import { WebSocket, WebSocketServer } from 'ws'

export type WsServerLog = { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }

export type StartWsServer = {
  port: number
  token: string
  onPeer: (ws: WebSocket) => void
  log: WsServerLog
}

// Bind 127.0.0.1 only; require the token as a Sec-WebSocket-Protocol subprotocol
// (swarm.<token>) so it never appears in URLs/logs. Allow one peer at a time.
export async function startWsServer(
  cfg: StartWsServer
): Promise<{ server: WebSocketServer; port: number; close: () => void }> {
  let peer: WebSocket | null = null
  const server = new WebSocketServer({
    host: '127.0.0.1',
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
    if (peer && peer.readyState === WebSocket.OPEN) {
      cfg.log.warn({ msg: 'ws-host second peer rejected', ip: req.socket.remoteAddress })
      ws.close(1008, 'another client is connected')
      return
    }
    peer = ws
    cfg.log.info({ msg: 'ws-host peer connected', ip: req.socket.remoteAddress })
    ws.on('close', () => {
      if (peer === ws) peer = null
      cfg.log.info({ msg: 'ws-host peer disconnected' })
    })
    cfg.onPeer(ws)
  })
  return { server, port: boundPort, close: () => server.close() }
}
