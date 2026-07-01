import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createMemoryStore, type MemoryStore } from './store'

function makeStore(): { store: MemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(`${tmpdir()}/swarm-memory-test-`)
  const store = createMemoryStore(join(dir, 'test.db'))
  return { store, cleanup: () => store.close() }
}

describe('createMemoryStore', () => {
  it('stores and recalls by query', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('tasks', 'task-1', 'Research the screen layout for the dashboard', 'fact')
      store.store('tasks', 'task-2', 'Open Safari and navigate to github.com', 'action')

      const results = store.recall('dashboard', 5)
      expect(results.length).toBe(1)
      expect(results[0].key).toBe('task-1')
      expect(results[0].content).toContain('dashboard')
    } finally {
      cleanup()
    }
  })

  it('filters by namespace', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('ns-a', 'k1', 'apple banana cherry', 'fruit')
      store.store('ns-b', 'k2', 'apple banana date', 'fruit')

      const results = store.recall('apple', 5, { namespace: 'ns-a' })
      expect(results.length).toBe(1)
      expect(results[0].namespace).toBe('ns-a')
    } finally {
      cleanup()
    }
  })

  it('filters by category', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('test', 'k1', 'important fact about API keys', 'credential')
      store.store('test', 'k2', 'important fact about database schema', 'schema')

      const results = store.recall('important', 5, { category: 'credential' })
      expect(results.length).toBe(1)
      expect(results[0].key).toBe('k1')
    } finally {
      cleanup()
    }
  })

  it('forget removes an entry', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('test', 'k1', 'temporary data', 'temp')
      expect(store.forget('test', 'k1')).toBe(true)
      expect(store.forget('test', 'k1')).toBe(false)
      expect(store.recall('temporary', 5).length).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('upserts on duplicate namespace+key', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('test', 'k1', 'version one', 'test')
      store.store('test', 'k1', 'version two updated', 'test')

      const results = store.recall('version', 5)
      expect(results.length).toBe(1)
      expect(results[0].content).toBe('version two updated')
    } finally {
      cleanup()
    }
  })

  it('returns empty for no matches', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('test', 'k1', 'hello world', 'test')
      expect(store.recall('nonexistent query xyz', 5).length).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('list returns entries newest-first', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('ns', 'old', 'first entry', 'note')
      store.store('ns', 'new', 'second entry', 'note')
      const all = store.list()
      expect(all.map((e) => e.key)).toEqual(['new', 'old'])
    } finally {
      cleanup()
    }
  })

  it('list filters by namespace', () => {
    const { store, cleanup } = makeStore()
    try {
      store.store('ns-a', 'k1', 'a', 'note')
      store.store('ns-b', 'k2', 'b', 'note')
      const onlyA = store.list('ns-a')
      expect(onlyA.length).toBe(1)
      expect(onlyA[0].namespace).toBe('ns-a')
    } finally {
      cleanup()
    }
  })

  it('onChange fires on store and forget', () => {
    const dir = mkdtempSync(`${tmpdir()}/swarm-memory-test-`)
    const onChange = vi.fn()
    const store = createMemoryStore(join(dir, 'test.db'), onChange)
    try {
      store.store('ns', 'k1', 'data', 'note')
      expect(onChange).toHaveBeenCalledTimes(1)
      store.forget('ns', 'k1')
      expect(onChange).toHaveBeenCalledTimes(2)
      store.forget('ns', 'missing')
      expect(onChange).toHaveBeenCalledTimes(2) // no-op forget does not fire
    } finally {
      store.close()
    }
  })
})
