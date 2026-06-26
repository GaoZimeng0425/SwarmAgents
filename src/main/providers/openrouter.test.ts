import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetCatalogCacheForTest,
  fetchCatalog,
  lookupModel,
  parseCatalog,
  readDiskCatalog,
  writeDiskCatalog,
} from './openrouter'

const sample = {
  data: [
    {
      id: 'anthropic/claude-3.5-sonnet',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
    },
    { id: 'openai/gpt-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
    { id: 'broken/no-price', context_length: 1000, pricing: { prompt: 'n/a', completion: 'n/a' } },
    { id: 'no-context-no-price' },
    { id: 'price/only', pricing: { prompt: '0.000001', completion: '0.000002' } },
  ],
}

describe('parseCatalog', () => {
  it('converts per-token USD strings to per-1M and keeps context_length', () => {
    const cat = parseCatalog(sample)
    expect(cat.get('anthropic/claude-3.5-sonnet')).toEqual({
      contextWindow: 200000,
      pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3 },
    })
  })
  it('keeps an entry with context but unparseable price (context only)', () => {
    expect(parseCatalog(sample).get('broken/no-price')).toEqual({ contextWindow: 1000 })
  })
  it('drops entries with neither context nor price', () => {
    expect(parseCatalog(sample).has('no-context-no-price')).toBe(false)
  })
  it('keeps a price-only entry with no contextWindow', () => {
    expect(parseCatalog(sample).get('price/only')).toEqual({
      pricing: { inputPerM: 1, outputPerM: 2 },
    })
  })
  it('tolerates malformed input', () => {
    expect(parseCatalog(null).size).toBe(0)
    expect(parseCatalog({ data: 'nope' }).size).toBe(0)
  })
})

describe('lookupModel', () => {
  const cat = parseCatalog(sample)
  it('matches exact id', () => {
    expect(lookupModel(cat, 'openai/gpt-4o')?.contextWindow).toBe(128000)
  })
  it('matches by suffix after the last slash', () => {
    expect(lookupModel(cat, 'gpt-4o')?.contextWindow).toBe(128000)
  })
  it('matches case-insensitively (exact and by suffix)', () => {
    expect(lookupModel(cat, 'OpenAI/GPT-4o')?.contextWindow).toBe(128000)
    expect(lookupModel(cat, 'GPT-4O')?.contextWindow).toBe(128000)
  })
  it('returns null when nothing matches', () => {
    expect(lookupModel(cat, 'totally-unknown')).toBeNull()
  })
})

describe('disk catalog persistence', () => {
  let path: string
  beforeEach(() => {
    path = join(tmpdir(), `swarm-catalog-${Date.now()}-${Math.random()}.json`)
    __resetCatalogCacheForTest()
  })
  afterEach(() => {
    try {
      rmSync(path)
    } catch {}
    vi.restoreAllMocks()
    __resetCatalogCacheForTest()
  })

  it('round-trips through disk', async () => {
    const cat = parseCatalog(sample)
    await writeDiskCatalog(path, 123, cat)
    const back = await readDiskCatalog(path)
    expect(back?.at).toBe(123)
    expect(back?.catalog.get('openai/gpt-4o')?.contextWindow).toBe(128000)
  })

  it('readDiskCatalog returns null for a missing file', async () => {
    expect(await readDiskCatalog(join(tmpdir(), 'does-not-exist.json'))).toBeNull()
  })

  it('fetchCatalog persists to disk on a successful network fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => sample }))
    )
    const cat = await fetchCatalog({ catalogPath: path })
    expect(cat.get('openai/gpt-4o')?.contextWindow).toBe(128000)
    // The on-disk copy mirrors what was fetched.
    const disk = await readDiskCatalog(path)
    expect(disk?.catalog.get('openai/gpt-4o')?.contextWindow).toBe(128000)
  })

  it('serves a fresh disk copy without hitting the network', async () => {
    await writeDiskCatalog(path, Date.now(), parseCatalog(sample))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const cat = await fetchCatalog({ catalogPath: path })
    expect(cat.get('openai/gpt-4o')?.contextWindow).toBe(128000)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to a stale disk copy when the network fails', async () => {
    // Stale (older than TTL): not eligible for the no-network fast path, but
    // still a valid offline fallback when the fetch itself fails.
    await writeDiskCatalog(path, Date.now() - 2 * 60 * 60 * 1000, parseCatalog(sample))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    const cat = await fetchCatalog({ catalogPath: path })
    expect(cat.get('openai/gpt-4o')?.contextWindow).toBe(128000)
  })

  it('throws when the network fails and no disk copy exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    await expect(fetchCatalog({ catalogPath: path })).rejects.toThrow('offline')
  })
})
