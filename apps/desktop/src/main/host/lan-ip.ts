import * as os from 'node:os'

// Enumerate network interfaces and return the first non-internal IPv4 address
// (e.g. "192.168.1.100"). Returns null if none found — the caller should
// fall back to displaying the token only, without a QR code.
export function getLanIp(): string | null {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}
