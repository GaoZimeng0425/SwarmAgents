// src/main/system/url-scheme.test.ts
import { describe, expect, it, vi } from 'vitest'

const { setAsDefaultProtocolClient, onMock } = vi.hoisted(() => ({
  setAsDefaultProtocolClient: vi.fn(() => true),
  onMock: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient,
    on: onMock,
  },
}))

import { registerUrlScheme } from './url-scheme'

describe('registerUrlScheme', () => {
  it('registers the scheme name as default protocol client', () => {
    registerUrlScheme('swarmagents', vi.fn())
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith('swarmagents')
  })
  it('subscribes to open-url for macOS', () => {
    onMock.mockClear()
    registerUrlScheme('swarmagents', vi.fn())
    expect(onMock).toHaveBeenCalledWith('open-url', expect.any(Function))
  })
})
