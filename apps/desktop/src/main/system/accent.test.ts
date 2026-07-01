// src/main/system/accent.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const listeners = new Map<string, Array<() => void>>()
  return {
    systemPreferences: {
      getAccentColor: vi.fn(() => '0080ffff'),
      on: vi.fn((evt: string, cb: () => void) => {
        const arr = listeners.get(evt) ?? []
        listeners.set(evt, [...arr, cb])
      }),
      // biome-ignore lint/style/useNamingConvention: test-only escape hatch on the mock
      __emit(evt: string) {
        listeners.get(evt)?.forEach((cb) => {
          cb()
        })
      },
    },
    nativeTheme: {
      on: vi.fn(),
    },
  }
})

import { systemPreferences } from 'electron'

import { getAccent, subscribeAccent } from './accent'

describe('accent', () => {
  it('returns systemPreferences.getAccentColor() as a hex string', () => {
    expect(getAccent()).toBe('0080ffff')
  })

  it('subscribers receive new accent on accent-color-changed', () => {
    const cb = vi.fn()
    const unsub = subscribeAccent(cb)
    ;(systemPreferences.getAccentColor as ReturnType<typeof vi.fn>).mockReturnValue('ff0000ff')
    ;(systemPreferences as unknown as { __emit: (e: string) => void }).__emit('accent-color-changed')
    expect(cb).toHaveBeenCalledWith('ff0000ff')
    unsub()
  })
})
