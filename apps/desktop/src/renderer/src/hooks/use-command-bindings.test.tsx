// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCommandBindingsStore } from '@/stores/command-bindings'
import { useCommandScope } from '@/stores/command-scope'
import { useCommandBindings } from './use-command-bindings'

// jsdom's userAgent is "Mozilla/5.0 (darwin) …", which does NOT contain "mac",
// so TanStack's detectPlatform() mis-detects it as linux and resolves `Mod` to
// Control instead of Meta. In the real Electron renderer on macOS the UA
// contains "Macintosh", so Mod resolves to ⌘ (metaKey). Force a macOS UA here
// so `Mod+K` is matched by `metaKey:true`, matching production behavior.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  })
})

// A host component that wires a handler for one command, so we can assert the
// real TanStack listener fires on a document-level keydown.
function Harness({ onCommand }: { onCommand: () => void }) {
  useCommandBindings({ 'search.toggle': onCommand })
  return null
}

beforeEach(() => {
  // Both stores are module-level singletons; reset between tests so state from
  // one case can't leak into another. The bindings store also persists to
  // localStorage, which must be cleared or hydrate() revives stale overrides.
  useCommandScope.getState().popScope('dialog')
  useCommandScope.getState().popScope('editor')
  useCommandBindingsStore.getState().resetAll()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useCommandBindings', () => {
  it('fires the handler when its hotkey is pressed', () => {
    const onCommand = vi.fn()
    render(<Harness onCommand={onCommand} />)
    // search.toggle binds to Mod+K; on macOS Mod is ⌘, so metaKey:true fires it.
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(onCommand).toHaveBeenCalledTimes(1)
  })

  it('does not fire when the active scope differs from the binding scope', () => {
    const onCommand = vi.fn()
    render(<Harness onCommand={onCommand} />)
    // Push a non-global scope; search.toggle is scoped to 'global', so it must
    // be suppressed while a dialog is open. Wrap the external store mutation in
    // act() so React flushes the re-render that syncs `enabled: false` onto the
    // TanStack handle before the keydown fires.
    act(() => {
      useCommandScope.getState().pushScope('dialog')
    })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(onCommand).not.toHaveBeenCalled()
    // Popping restores global scope and the command fires again.
    act(() => {
      useCommandScope.getState().popScope('dialog')
    })
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(onCommand).toHaveBeenCalledTimes(1)
  })

  it('honors user overrides from the command-bindings store', () => {
    const onCommand = vi.fn()
    // Rebind search.toggle from Mod+K to Mod+P before mount.
    useCommandBindingsStore.getState().setBinding('search.toggle', 'Mod+P')
    render(<Harness onCommand={onCommand} />)
    // Old binding no longer fires.
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(onCommand).not.toHaveBeenCalled()
    // New binding fires.
    fireEvent.keyDown(document, { key: 'p', metaKey: true })
    expect(onCommand).toHaveBeenCalledTimes(1)
  })
})
