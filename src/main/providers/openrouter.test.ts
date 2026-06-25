import { describe, expect, it } from 'vitest'

import { lookupModel, parseCatalog } from './openrouter'

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
