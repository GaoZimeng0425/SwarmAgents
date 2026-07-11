export type ConnectionConfig = {
  host: string
  port: number
  token: string
}

// Parse the QR content "swarm:<ip>:<port>?token=<token>" into a structured
// connection config. Throws on any malformed input — the caller should catch
// and show a user-facing error.
export function parseQr(qr: string): ConnectionConfig {
  // Format: swarm:<ip>:<port>?token=<token>
  // The IP may contain dots (IPv4) or colons (IPv6) — for IPv6 we'd need
  // bracket notation, but the desktop getLanIp() returns IPv4 only.
  const match = qr.match(/^swarm:(.+):(\d+)\?token=(.+)$/)
  if (!match) throw new Error('Invalid QR format: expected swarm:<ip>:<port>?token=<token>')

  const [, host, portStr, token] = match
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid QR format: port out of range')
  }

  return { host, port, token }
}
