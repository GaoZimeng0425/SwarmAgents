import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMemoryStore, type MemoryStore } from '../memory/store'
import { memorySpecs } from './memory'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
  sendMessage: async () => {},
  sendAndWait: async () => '',
  findPeers: () => [],
}

let dir: string
let store: MemoryStore
let specs: ReturnType<typeof memorySpecs>
const tool = (name: string) => specs.find((s) => s.name === name)!.build(ctx)

/** Narrow a content item to its text, matching mcp/manager.ts:textOf. */
const textOf = (c: { type: string; text?: string }): string => (c.type === 'text' ? c.text ?? '' : '')

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-mem-tool-'))
  store = createMemoryStore(join(dir, 'mem.json'))
  specs = memorySpecs(store)
})
afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('memorySpecs', () => {
  it('exposes remember/recall/forget under the memory group, all low risk', () => {
    expect(specs.map((s) => `${s.group}.${s.name}`).sort()).toEqual([
      'memory.forget',
      'memory.recall',
      'memory.remember',
    ])
    expect(specs.every((s) => s.risk === 'low')).toBe(true)
  })
})

describe('remember + recall', () => {
  it('remembers a fact and recalls it by query', async () => {
    await tool('remember').execute('c', { key: 'fav-editor', content: 'The user prefers the Zed editor' })
    const res = await tool('recall').execute('c', { query: 'editor' })
    expect(textOf(res.content[0])).toContain('Zed')
    expect((res.details as { count: number }).count).toBe(1)
  })

  it('reports no matches cleanly', async () => {
    const res = await tool('recall').execute('c', { query: 'nonexistent-topic-xyz' })
    expect((res.details as { count: number }).count).toBe(0)
    expect(textOf(res.content[0])).toMatch(/no match/i)
  })

  it('rejects an empty key or content', async () => {
    const a = await tool('remember').execute('c', { key: '', content: 'x' })
    expect((a.details as { error?: string }).error).toBeTruthy()
    const b = await tool('remember').execute('c', { key: 'k', content: '' })
    expect((b.details as { error?: string }).error).toBeTruthy()
  })

  it('honours an explicit namespace for isolation', async () => {
    await tool('remember').execute('c', { key: 'p', content: 'project alpha uses postgres', namespace: 'proj' })
    const inDefault = await tool('recall').execute('c', { query: 'postgres' })
    expect((inDefault.details as { count: number }).count).toBe(0)
    const inProj = await tool('recall').execute('c', { query: 'postgres', namespace: 'proj' })
    expect((inProj.details as { count: number }).count).toBe(1)
  })

  it('limits the number of results', async () => {
    await tool('remember').execute('c', { key: 'm1', content: 'meeting notes one', namespace: 'lim' })
    await tool('remember').execute('c', { key: 'm2', content: 'meeting notes two', namespace: 'lim' })
    await tool('remember').execute('c', { key: 'm3', content: 'meeting notes three', namespace: 'lim' })
    const res = await tool('recall').execute('c', { query: 'meeting', namespace: 'lim', limit: 2 })
    expect((res.details as { count: number }).count).toBe(2)
  })
})

describe('forget', () => {
  it('removes a remembered entry', async () => {
    await tool('remember').execute('c', { key: 'temp', content: 'ephemeral note', namespace: 'fg' })
    const removed = await tool('forget').execute('c', { key: 'temp', namespace: 'fg' })
    expect((removed.details as { removed: boolean }).removed).toBe(true)
    const again = await tool('forget').execute('c', { key: 'temp', namespace: 'fg' })
    expect((again.details as { removed: boolean }).removed).toBe(false)
    const res = await tool('recall').execute('c', { query: 'ephemeral', namespace: 'fg' })
    expect((res.details as { count: number }).count).toBe(0)
  })
})
