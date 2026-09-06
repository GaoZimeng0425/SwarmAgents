// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useEffect, useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StickToBottomList, useStickToBottom, useStickToBottomList } from './stick-to-bottom-list'

afterEach(() => {
  cleanup()
})

// Mount the hook against a real div so the ref + scroll listener attach. We mock
// scrollHeight/clientHeight/scrollTop on the instance (the test DOM does no layout, so
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
// drive scrollTop (the setter records into `state.scrollTop`). The test DOM in
// this env has no Element.scrollTo, so install one that applies the `top` offset — the
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
})

// A consumer that reads the context, like a "scroll to latest" button would.
function ContextProbe() {
  const { isAtBottom } = useStickToBottomList()
  return <div data-at-bottom={isAtBottom ? '1' : '0'} data-testid="probe" />
}

// useStickToBottomList must throw when called outside the provider.
function ThrowingConsumer() {
  useStickToBottomList()
  return null
}

describe('StickToBottomList', () => {
  it('renders the ScrollArea, its items, and exposes context to children', () => {
    render(
      <StickToBottomList
        className="h-[600px]"
        getKey={(s) => s}
        items={['one', 'two']}
        renderItem={(s) => <div>{s}</div>}
      >
        <ContextProbe />
      </StickToBottomList>
    )
    expect(document.querySelector('[data-slot="scroll-area"]')).not.toBeNull()
    expect(screen.getByText('one')).toBeInTheDocument()
    // Initial state is stuck at the bottom.
    expect(screen.getByTestId('probe').getAttribute('data-at-bottom')).toBe('1')
  })

  it('throws when useStickToBottomList is called outside the provider', () => {
    // Suppress the expected console.error from React for the thrown render.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ThrowingConsumer />)).toThrow(/useStickToBottomList/)
    spy.mockRestore()
  })
})

function ScrollToKeyProbe({ targetKey }: { targetKey: string }) {
  const { scrollToKey } = useStickToBottomList()
  useEffect(() => {
    scrollToKey(targetKey)
  }, [targetKey, scrollToKey])
  return null
}

describe('StickToBottomList.scrollToKey', () => {
  it('exposes scrollToKey and calling it for a known key does not throw', () => {
    expect(() =>
      render(
        <StickToBottomList
          getKey={(it: { id: string }) => it.id}
          items={[{ id: 'a' }, { id: 'b' }, { id: 'c' }]}
          renderItem={(it: { id: string }) => <div>{it.id}</div>}
        >
          <ScrollToKeyProbe targetKey="b" />
        </StickToBottomList>
      )
    ).not.toThrow()
  })

  it('scrollToKey for an unknown key is a no-op (does not throw)', () => {
    expect(() =>
      render(
        <StickToBottomList
          getKey={(it: { id: string }) => it.id}
          items={[{ id: 'a' }]}
          renderItem={(it: { id: string }) => <div>{it.id}</div>}
        >
          <ScrollToKeyProbe targetKey="missing" />
        </StickToBottomList>
      )
    ).not.toThrow()
  })
})
