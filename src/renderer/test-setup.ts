import '@testing-library/jest-dom/vitest'

// jsdom does not implement ResizeObserver, but several components observe element
// size on mount (chat-input tools row, document/pdf viewers). Provide a no-op
// stub so those components can render in tests without crashing in a passive effect.
if (!globalThis.ResizeObserver) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}
