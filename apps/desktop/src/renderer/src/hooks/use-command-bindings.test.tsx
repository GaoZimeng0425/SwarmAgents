// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCommandBindingsStore } from '@/stores/command-bindings'
import { useCommandScope } from '@/stores/command-scope'
import { useCommandBindings } from './use-command-bindings'

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
    // search.toggle binds to Mod+K; on jsdom, metaKey:true models the Mod chord.
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(onCommand).toHaveBeenCalledTimes(1)
  })

  it('does not fire when the active scope differs from the binding scope', () => {
    const onCommand = vi.fn()
    render(<Harness onCommand={onCommand} />)
    // Push a non-global scope; search.toggle is scoped to 'global', so it must
    // be suppressed while a dialog is open.
    useCommandScope.getState().pushScope('dialog')
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(onCommand).not.toHaveBeenCalled()
    // Popping restores global scope and the command fires again.
    useCommandScope.getState().popScope('dialog')
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
