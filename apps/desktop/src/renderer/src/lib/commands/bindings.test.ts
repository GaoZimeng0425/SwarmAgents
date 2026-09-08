import { describe, expect, it } from 'vitest'

import { DEFAULT_BINDINGS, resolveBindings } from './bindings'
import type { CommandId } from './definitions'
import { COMMANDS } from './definitions'

describe('DEFAULT_BINDINGS', () => {
  it('every bound command id exists in COMMANDS', () => {
    const ids = Object.keys(DEFAULT_BINDINGS) as CommandId[]
    for (const id of ids) {
      expect(COMMANDS[id], `unknown command id ${id}`).toBeDefined()
    }
  })

  it('uses Mod+ for cross-platform bindings (not Meta/Control literally)', () => {
    for (const [id, b] of Object.entries(DEFAULT_BINDINGS)) {
      if (!b) continue
      // Single bare keys (Escape) need no Mod; only assert portability of combos.
      if (b.hotkey.includes('+')) {
        expect(b.hotkey, `${id} should use Mod+`).toMatch(/^(Mod\+|Shift\+)/)
        // No literal Control+/Meta+ in defaults — those are platform-specific.
        expect(b.hotkey).not.toMatch(/\b(Control|Meta|Cmd|Command)\+/)
      }
    }
  })
})

describe('resolveBindings', () => {
  it('returns defaults when no overrides are given', () => {
    const { bindings } = resolveBindings()
    expect(bindings['search.toggle']?.hotkey).toBe('Mod+K')
    expect(bindings['permission.skipTop']?.hotkey).toBe('Escape')
  })

  it('overrides only the hotkey, keeping scope/options from the default', () => {
    const { bindings } = resolveBindings({ 'search.toggle': 'Mod+P' })
    expect(bindings['search.toggle']?.hotkey).toBe('Mod+P')
    // scope and options are preserved from the default binding
    expect(bindings['search.toggle']?.scope).toBe('global')
    // another command is untouched
    expect(bindings['permission.skipTop']?.hotkey).toBe('Escape')
  })

  it('reports conflicts when two commands share hotkey + scope', () => {
    // search.toggle (Mod+K, global) and permission.skipTop (Escape, global) are
    // not in conflict by default.
    expect(resolveBindings().conflicts).toEqual([])

    // Force a collision: bind search.toggle to Escape (global) like skipTop.
    const { conflicts } = resolveBindings({ 'search.toggle': 'Escape' })
    expect(conflicts).toContain('search.toggle')
    expect(conflicts).toContain('permission.skipTop')
  })

  it('does not treat same hotkey across different scopes as a conflict', () => {
    // Escape appears in both 'global' (permission.skipTop) and 'dialog'
    // (settings.close) defaults — these are different scopes, no conflict.
    const { conflicts } = resolveBindings()
    expect(conflicts).not.toContain('settings.close')
  })

  it('preserves per-binding options through resolution', () => {
    const { bindings } = resolveBindings()
    // permission.skipTop carries preventDefault:false / stopPropagation:false
    expect(bindings['permission.skipTop']?.options?.preventDefault).toBe(false)
    expect(bindings['permission.skipTop']?.options?.stopPropagation).toBe(false)
  })
})
