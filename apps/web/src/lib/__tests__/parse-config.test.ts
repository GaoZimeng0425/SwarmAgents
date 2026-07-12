import { parseConnectionConfig } from '../parse-config'

describe('parseConnectionConfig', () => {
  it('parses valid input with trimming', () => {
    expect(parseConnectionConfig('  192.168.1.100  ', ' 47777 ', '  abc123  ')).toEqual({
      host: '192.168.1.100',
      port: 47777,
      token: 'abc123',
    })
  })

  it('throws on empty host', () => {
    expect(() => parseConnectionConfig('', '47777', 'abc')).toThrow(/主机地址/)
  })

  it('throws on whitespace-only host', () => {
    expect(() => parseConnectionConfig('   ', '47777', 'abc')).toThrow(/主机地址/)
  })

  it('throws on empty token', () => {
    expect(() => parseConnectionConfig('192.168.1.1', '47777', '')).toThrow(/token/i)
  })

  it('throws on non-numeric port', () => {
    expect(() => parseConnectionConfig('192.168.1.1', 'abc', 'tok')).toThrow(/端口/)
  })

  it('throws on port out of range (zero)', () => {
    expect(() => parseConnectionConfig('192.168.1.1', '0', 'tok')).toThrow(/端口/)
  })

  it('throws on port out of range (too large)', () => {
    expect(() => parseConnectionConfig('192.168.1.1', '65536', 'tok')).toThrow(/端口/)
  })
})
