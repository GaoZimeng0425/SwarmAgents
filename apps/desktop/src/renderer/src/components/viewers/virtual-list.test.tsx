// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  computeItemOffset,
  pickNewAnchors,
  type ScrollToItemOptions,
  useStickToBottom,
  useVirtualList,
  VirtualList,
} from './virtual-list'

afterEach(() => {
  cleanup()
})

// Mount the hook against a real div so the ref + scroll listener attach. We mock
// scrollHeight/clientHeight/scrollTop on the instance (jsdom does no layout, so
// these are 0 and scrollTop assignment is a no-op without our override).
function Harness({ totalSize, tolerance }: { totalSize: number; tolerance?: number }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const stick = useStickToBottom(viewportRef, totalSize, tolerance)
  return (
    <>
      <div data-at-bottom={stick.isAtBottom ? '1' : '0'} data-testid="vp" ref={viewportRef} />
      <button data-testid="to-bottom" onClick={() => stick.scrollToBottom('auto')} type="button" />
    </>
  )
}

// Install scroll-dimension mocks on a mounted element. Returns a handle to read/
// drive scrollTop (the setter records into `state.scrollTop`). jsdom in this env
// has no Element.scrollTo, so install one that applies the `top` offset — the
// hook calls el.scrollTo({ top, behavior }) from scrollToBottom().
function mockScroll(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  const state = { scrollTop: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = v
    },
  })
  el.scrollTo = ((opts?: number | ScrollToOptions) => {
    const top = typeof opts === 'number' ? opts : opts?.top
    if (typeof top === 'number') state.scrollTop = top
  }) as typeof el.scrollTo
  return state
}

describe('useStickToBottom', () => {
  it('starts stuck at the bottom', () => {
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    mockScroll(vp, 1000, 200)
    expect(vp.getAttribute('data-at-bottom')).toBe('1')
  })

  it('unsticks when the user scrolls away from the bottom', () => {
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    state.scrollTop = 0 // user scrolled to top
    fireEvent.scroll(vp)
    expect(vp.getAttribute('data-at-bottom')).toBe('0')
  })

  it('does NOT pin when content grows while the user is scrolled up', () => {
    const { container, rerender } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    state.scrollTop = 0
    fireEvent.scroll(vp) // unstuck

    rerender(<Harness totalSize={500} />) // content grew
    // stuck === false → layout effect must not touch scrollTop (and scrollToBottom
    // was never called; the pin path uses direct scrollTop assignment anyway).
    expect(state.scrollTop).toBe(0)
  })

  it('re-sticks and pins to bottom on scrollToBottom()', () => {
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    state.scrollTop = 0
    fireEvent.scroll(vp) // unstuck
    expect(vp.getAttribute('data-at-bottom')).toBe('0')

    fireEvent.click(container.querySelector('[data-testid="to-bottom"]')!)
    expect(vp.getAttribute('data-at-bottom')).toBe('1')
    // scrollToBottom('auto') lands at scrollHeight.
    expect(state.scrollTop).toBe(1000)
  })

  it('re-pins to the new bottom when content grows while stuck', () => {
    const { container, rerender } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    // ensure stuck (initial state is stuck=true)
    fireEvent.click(container.querySelector('[data-testid="to-bottom"]')!)
    expect(state.scrollTop).toBe(1000)

    rerender(<Harness totalSize={900} />) // content grew while stuck
    expect(state.scrollTop).toBe(1000) // pinned to scrollHeight (=1000)
  })

  it('keeps stick state while the user drag-selects text inside the scroller', () => {
    // Drag-selecting text extends the selection and can nudge scrollTop upward;
    // those scroll events are a side-effect of selection, not a user intent to
    // leave the bottom — so isSelecting() must keep the prior stuck state intact.
    const { container } = render(<Harness totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    // Start stuck at the bottom.
    fireEvent.click(container.querySelector('[data-testid="to-bottom"]')!)
    expect(vp.getAttribute('data-at-bottom')).toBe('1')

    // Simulate a drag-select: mouse down, build a selection inside the viewport.
    fireEvent.mouseDown(document)
    const sel = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(vp)
    sel.removeAllRanges()
    sel.addRange(range)

    // The selection expansion moves scrollTop up; without isSelecting() this
    // would drop stick-to-bottom. The hook must ignore this scroll.
    state.scrollTop = 0
    fireEvent.scroll(vp)
    expect(vp.getAttribute('data-at-bottom')).toBe('1') // still stuck

    // Once the mouse is released, subsequent real scrolls are judged again.
    sel.removeAllRanges()
    fireEvent.mouseUp(document)
    state.scrollTop = 0
    fireEvent.scroll(vp)
    expect(vp.getAttribute('data-at-bottom')).toBe('0') // unstuck as expected
  })
})

// A consumer that reads the context, like a "scroll to latest" button would.
function ContextProbe() {
  const { isAtBottom } = useVirtualList()
  return <div data-at-bottom={isAtBottom ? '1' : '0'} data-testid="probe" />
}

// useVirtualList must throw when called outside the provider.
function ThrowingConsumer() {
  useVirtualList()
  return null
}

// Captures scrollToItem so tests can drive imperative jumps from a consumer's
// perspective. Only the unknown-key path is asserted in jsdom: the happy path
// needs real row measurements, which jsdom (no layout) cannot produce.
let capturedScrollToItem: ((key: string, opts?: ScrollToItemOptions) => boolean) | null = null
function ScrollCapture() {
  const { scrollToItem } = useVirtualList()
  capturedScrollToItem = scrollToItem
  return null
}

describe('VirtualList', () => {
  it('renders its native scroller, items, and exposes context to children', () => {
    render(
      <VirtualList className="h-[600px]" getKey={(s) => s} items={['one', 'two']} renderItem={(s) => <div>{s}</div>}>
        <ContextProbe />
      </VirtualList>
    )
    // Native scroller (no base-ui ScrollArea) — assert by its data attribute.
    expect(document.querySelector('[data-virtual-scroller]')).not.toBeNull()
    expect(screen.getByText('one')).toBeInTheDocument()
    // Initial state is stuck at the bottom.
    expect(screen.getByTestId('probe').getAttribute('data-at-bottom')).toBe('1')
  })

  it('throws when useVirtualList is called outside the provider', () => {
    // Suppress the expected console.error from React for the thrown render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ThrowingConsumer />)).toThrow(/useVirtualList/)
    spy.mockRestore()
  })

  it('exposes scrollToItem and rejects unknown keys', () => {
    render(
      <VirtualList getKey={(s) => s} items={['one', 'two']} renderItem={(s) => <div>{s}</div>}>
        <ScrollCapture />
      </VirtualList>
    )
    expect(capturedScrollToItem).not.toBeNull()
    expect(capturedScrollToItem!('nope')).toBe(false)
  })

  it('annotates scroller, log content, and rows for assistive tech', () => {
    render(<VirtualList getKey={(s) => s} items={['one']} renderItem={(s) => <div>{s}</div>} />)
    const scroller = document.querySelector('[data-virtual-scroller]')!
    expect(scroller.getAttribute('role')).toBe('region')
    expect(scroller.getAttribute('aria-label')).toBe('Messages')
    expect(scroller.getAttribute('tabindex')).toBe('0')
    expect(document.querySelector('[role="log"]')).not.toBeNull()
    expect(document.querySelector('[data-message-id="one"]')).not.toBeNull()
  })
})

describe('computeItemOffset', () => {
  // Minimal stand-in for virtual-core's getOffsetForIndex: item 0 starts at 500
  // and is 200 tall; `resolvedAlign` simulates what 'auto'/'nearest' resolves to.
  function fakeSource(resolvedAlign: 'start' | 'auto') {
    return {
      getOffsetForIndex: (index: number, align: 'start' | 'center' | 'end' | 'auto') => {
        if (index !== 0) return undefined
        if (align === 'end') return [700, 'end'] as const
        return [500, resolvedAlign] as const
      },
    }
  }

  it('lands a start-aligned item at its start offset', () => {
    expect(computeItemOffset(fakeSource('start'), 0, 'start')).toBe(500)
  })

  it('applies peek to start alignment', () => {
    expect(computeItemOffset(fakeSource('start'), 0, 'start', 100)).toBe(400)
  })

  it('clamps start+peek at 0', () => {
    expect(computeItemOffset(fakeSource('start'), 0, 'start', 800)).toBe(0)
  })

  it('ignores peek for end alignment', () => {
    expect(computeItemOffset(fakeSource('start'), 0, 'end', 100)).toBe(700)
  })

  it('nearest keeps peek when auto resolves to start (item above viewport)', () => {
    expect(computeItemOffset(fakeSource('start'), 0, 'nearest', 100)).toBe(400)
  })

  it("nearest drops peek when auto resolves to 'auto' (item already visible)", () => {
    expect(computeItemOffset(fakeSource('auto'), 0, 'nearest', 100)).toBe(500)
  })

  it('returns undefined for out-of-range indexes', () => {
    expect(computeItemOffset(fakeSource('start'), 3, 'start')).toBeUndefined()
  })
})

describe('pickNewAnchors', () => {
  it('yields nothing on the first render (session open lands at the bottom)', () => {
    expect(pickNewAnchors(new Set(), ['u1', 'u2'], false)).toEqual([])
  })

  it('returns only keys absent from the previous render', () => {
    expect(pickNewAnchors(new Set(['u1']), ['u1', 'u2'], true)).toEqual(['u2'])
  })

  it('returns every fresh key so callers can treat >1 as a batch', () => {
    expect(pickNewAnchors(new Set(), ['u1', 'u2'], true)).toEqual(['u1', 'u2'])
  })

  it('yields nothing when nothing is new', () => {
    expect(pickNewAnchors(new Set(['u1']), ['u1'], true)).toEqual([])
  })
})

// Harness exercising the pin suspender: while suspended (turn-anchor mode owns
// the viewport), the stick pin must stand down instead of fighting the anchor.
function SuspenderHarness({ totalSize, suspended }: { totalSize: number; suspended: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const pinSuspenderRef = useRef(suspended)
  pinSuspenderRef.current = suspended
  const stick = useStickToBottom(viewportRef, totalSize, 4, { pinSuspenderRef })
  return (
    <>
      <div data-testid="vp2" ref={viewportRef} />
      <button data-testid="to-bottom2" onClick={() => stick.scrollToBottom('auto')} type="button" />
    </>
  )
}

describe('useStickToBottom pin suspender', () => {
  it('stands down the bottom pin while suspended, resumes when released', () => {
    const { container, rerender } = render(<SuspenderHarness suspended={true} totalSize={100} />)
    const vp = container.querySelector('[data-testid="vp2"]') as HTMLDivElement
    const state = mockScroll(vp, 1000, 200)

    // Suspended: content "grows" but the pin must not fire.
    rerender(<SuspenderHarness suspended={true} totalSize={900} />)
    expect(state.scrollTop).toBe(0)

    // Released: the next totalSize change pins to the bottom again.
    rerender(<SuspenderHarness suspended={false} totalSize={950} />)
    expect(state.scrollTop).toBe(1000)
  })
})
