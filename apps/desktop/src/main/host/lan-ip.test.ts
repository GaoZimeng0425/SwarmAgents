import * as os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getLanIp } from './lan-ip'

// vi.spyOn cannot patch `os.networkInterfaces` because the ESM namespace export
// is non-configurable. vi.mock is hoisted by vitest and intercepts the module
// at load time, so each test rewrites the mock's return value instead.
vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}))

describe('getLanIp', () => {
  afterEach(() => {
    vi.mocked(os.networkInterfaces).mockReset()
  })

  beforeEach(() => {
    // Default: real-ish empty so a forgotten mock doesn't bleed across tests.
    vi.mocked(os.networkInterfaces).mockReturnValue({})
  })

  it('returns the first non-internal IPv4 address', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.1.100', family: 'IPv4', internal: false }],
    } as unknown as ReturnType<typeof os.networkInterfaces>)
    expect(getLanIp()).toBe('192.168.1.100')
  })

  it('skips IPv6 addresses', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.1.50', family: 'IPv4', internal: false },
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>)
    expect(getLanIp()).toBe('192.168.1.50')
  })

  it('returns null when no non-internal IPv4 interface exists', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    } as unknown as ReturnType<typeof os.networkInterfaces>)
    expect(getLanIp()).toBeNull()
  })

  it('returns null when networkInterfaces returns empty', () => {
    vi.mocked(os.networkInterfaces).mockReturnValue({} as unknown as ReturnType<typeof os.networkInterfaces>)
    expect(getLanIp()).toBeNull()
  })
})
