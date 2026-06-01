import { describe, expect, it } from 'vitest'

import { estimateMessagesTokens, estimateTokens } from './tokens'

describe('estimateTokens', () => {
  it('estimates ~1 token per 4 characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('Hello, world!')).toBe(4)
  })

  it('handles long strings', () => {
    const text = 'a'.repeat(4000)
    expect(estimateTokens(text)).toBe(1000)
  })
})

describe('estimateMessagesTokens', () => {
  it('sums role and content tokens', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const tokens = estimateMessagesTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
  })

  it('handles non-string content', () => {
    const msgs = [{ role: 'tool', content: { key: 'value' } }]
    const tokens = estimateMessagesTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
  })

  it('handles null content', () => {
    const msgs = [{ role: 'assistant', content: null }]
    const tokens = estimateMessagesTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
  })
})
