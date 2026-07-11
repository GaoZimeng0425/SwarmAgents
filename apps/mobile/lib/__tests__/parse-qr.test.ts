import { parseQr } from '../parse-qr'

describe('parseQr', () => {
  it('parses a valid QR string', () => {
    const qr = 'swarm:192.168.1.100:47777?token=abc123def456'
    expect(parseQr(qr)).toEqual({
      host: '192.168.1.100',
      port: 47777,
      token: 'abc123def456',
    })
  })

  it('throws on missing scheme prefix', () => {
    expect(() => parseQr('192.168.1.100:47777?token=abc')).toThrow(/invalid qr format/i)
  })

  it('throws on missing token', () => {
    expect(() => parseQr('swarm:192.168.1.100:47777')).toThrow(/invalid qr format/i)
  })

  it('throws on missing port', () => {
    expect(() => parseQr('swarm:192.168.1.100?token=abc')).toThrow(/invalid qr format/i)
  })

  it('throws on non-numeric port', () => {
    expect(() => parseQr('swarm:192.168.1.100:abc?token=xyz')).toThrow(/invalid qr format/i)
  })

  it('throws on empty string', () => {
    expect(() => parseQr('')).toThrow(/invalid qr format/i)
  })
})
