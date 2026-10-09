import '@testing-library/jest-dom/vitest'

// Not every test DOM implements ResizeObserver, but several components observe
// element size on mount (chat-input tools row, document/pdf viewers). Provide a
// no-op stub so those components can render in tests without crashing in a
// passive effect.
if (!globalThis.ResizeObserver) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// Not every test DOM implements IntersectionObserver; ConversationMinimap
// observes user-turn elements to highlight the in-view tick. Provide a no-op
// stub so the component mounts in tests without crashing.
if (!globalThis.IntersectionObserver) {
  class IntersectionObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
}

// The remaining stubs need DOM globals. Renderer tests that opt into the `node`
// environment (pure-logic specs via `// @vitest-environment node`) share this
// setup file, so guard on the DOM being present before touching it.
if (typeof Element !== 'undefined' && typeof HTMLElement !== 'undefined') {
  // happy-dom does not implement Element.getAnimations(); base-ui's ScrollArea
  // viewport calls it on a timer to coordinate scroll-end animations. Stub it so
  // the styled ScrollArea (used app-wide, including the VirtualList) renders in
  // tests without throwing an unhandled error from that timeout.
  if (!Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => []
  }

  // The test DOM may implement neither Element.scrollIntoView nor the Pointer
  // Capture API, both of which base-ui's Select touches when its popup opens
  // (it scrolls the active item into view and captures the pointer on the
  // trigger). Stub them so Select-based fields can be opened in tests without
  // throwing.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }

  // The test DOM has no layout engine, so offsetWidth/offsetHeight are always
  // 0. That
  // starves `@tanstack/react-virtual`, which sizes its scroll viewport and
  // measures rows via offsetHeight: a 0px viewport makes it render no rows.
  // Report a non-zero default so virtualized lists (VirtualList) mount visible
  // rows in tests; elements with an explicit inline pixel size keep that size.
  const pxOrDefault = (value: string | undefined, fallback: number): number => {
    const n = Number.parseFloat(value ?? '')
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(): number {
      return pxOrDefault((this as HTMLElement).style?.height, 600)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(): number {
      return pxOrDefault((this as HTMLElement).style?.width, 800)
    },
  })
}
