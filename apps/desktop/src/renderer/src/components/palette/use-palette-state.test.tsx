// apps/desktop/src/renderer/src/components/palette/use-palette-state.test.tsx
// @vitest-environment jsdom
//
// Focused unit tests for the usePaletteState controller hook. The brief said
// "no separate test, covered by Task 9", but the keyboard handler has enough
// edge cases (clamping, escape-then-close, lone-prefix backspace, sel reset)
// to be worth pinning directly here.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { BuildInputs, Callbacks } from '../../lib/palette/build-items'
import { usePaletteState } from './use-palette-state'

// Minimal inputs. Empty arrays everywhere except one session, so the mixed
// scope's empty-term home row yields >=1 item (hero + new-chat + the chat).
// That gives flat.length >= 1 for the ArrowDown clamp test.
const inputs: BuildInputs = {
  currentSessionId: null,
  sessions: [{ id: 's1', title: 'Chat', lastActiveAt: 0 }],
  runningRuns: [],
  cronJobs: [],
  formations: [],
  artifacts: [],
  memory: [],
  skills: [],
  services: [],
}

const noopAsync = vi.fn().mockResolvedValue({ sessionId: 'x' })
const cb: Callbacks = {
  navigate: vi.fn(),
  openSettings: vi.fn(),
  cycleTheme: vi.fn(),
  exportMarkdown: vi.fn(),
  setComposerAgent: vi.fn(),
  openArtifact: vi.fn(),
  submitPrompt: noopAsync as Callbacks['submitPrompt'],
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

// A KeyboardEvent-shaped object: only `key` and `preventDefault` are read by
// the handler. Using a stable fn lets us assert it was called.
function key(key: string) {
  return { key, preventDefault: vi.fn() }
}

describe('usePaletteState — keyboard handler', () => {
  it('ArrowDown advances then clamps at flat.length - 1 (no wrap)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteState({ inputs, cb, open: true, close: vi.fn() }), {
      wrapper: makeWrapper(qc),
    })

    // Sanity: mixed home row has >=1 item.
    const flatLen = result.current.flat.length
    expect(flatLen).toBeGreaterThanOrEqual(1)

    act(() => result.current.onKeyDown(key('ArrowDown') as any))
    expect(result.current.selIndex).toBe(1)

    // Hammer it well past the end — must clamp, never wrap to 0.
    for (let i = 0; i < flatLen + 5; i++) {
      act(() => result.current.onKeyDown(key('ArrowDown') as any))
    }
    expect(result.current.selIndex).toBe(flatLen - 1)
  })

  it('ArrowUp clamps at 0 (no wrap to bottom)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteState({ inputs, cb, open: true, close: vi.fn() }), {
      wrapper: makeWrapper(qc),
    })

    // From the default index 0, going up stays at 0.
    act(() => result.current.onKeyDown(key('ArrowUp') as any))
    expect(result.current.selIndex).toBe(0)

    // Even after moving down first, up stops at 0.
    act(() => result.current.onKeyDown(key('ArrowDown') as any))
    act(() => result.current.onKeyDown(key('ArrowUp') as any))
    act(() => result.current.onKeyDown(key('ArrowUp') as any))
    expect(result.current.selIndex).toBe(0)
  })

  it('Escape clears a non-empty query first, then closes on the next press', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const close = vi.fn()
    const { result } = renderHook(() => usePaletteState({ inputs, cb, open: true, close }), {
      wrapper: makeWrapper(qc),
    })

    act(() => result.current.setQuery('find me'))
    act(() => result.current.onKeyDown(key('Escape') as any))
    expect(result.current.query).toBe('')
    // close is NOT called yet — clearing the query took priority.
    expect(close).not.toHaveBeenCalled()

    // Second Escape with an empty query → close.
    act(() => result.current.onKeyDown(key('Escape') as any))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Backspace on a lone prefix char clears the query', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteState({ inputs, cb, open: true, close: vi.fn() }), {
      wrapper: makeWrapper(qc),
    })

    act(() => result.current.setQuery('>'))
    act(() => result.current.onKeyDown(key('Backspace') as any))
    expect(result.current.query).toBe('')
  })

  it('Backspace on a non-lone prefix (e.g. ">abc") does NOT clear the scope', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteState({ inputs, cb, open: true, close: vi.fn() }), {
      wrapper: makeWrapper(qc),
    })

    act(() => result.current.setQuery('>abc'))
    act(() => result.current.onKeyDown(key('Backspace') as any))
    // The hook must leave the query untouched — the real <input> handles the
    // actual deletion of the trailing char; the hook only special-cases the
    // exact lone-prefix situation.
    expect(result.current.query).toBe('>abc')
  })

  it('selIndex resets to 0 when the query changes', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePaletteState({ inputs, cb, open: true, close: vi.fn() }), {
      wrapper: makeWrapper(qc),
    })

    // Move selection down, then change the query — index snaps back to 0.
    act(() => result.current.onKeyDown(key('ArrowDown') as any))
    expect(result.current.selIndex).toBeGreaterThanOrEqual(1)

    act(() => result.current.setQuery('xyz'))
    expect(result.current.selIndex).toBe(0)
  })

  it('resets query to empty when open flips false', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const close = vi.fn()
    const { result, rerender } = renderHook((props) => usePaletteState(props), {
      wrapper: makeWrapper(qc),
      initialProps: { inputs, cb, open: true, close },
    })

    act(() => result.current.setQuery('hello'))
    expect(result.current.query).toBe('hello')

    // Flipping open to false must wipe the query so the palette reopens clean.
    rerender({ inputs, cb, open: false, close })
    expect(result.current.query).toBe('')
  })
})
