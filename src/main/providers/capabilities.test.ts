import { describe, expect, it } from 'vitest'

import { effectiveThinkingLevel, modelSupportsImagesFromInput, modelThinkingLevels } from './capabilities'

describe('modelSupportsImagesFromInput', () => {
  it('true when the model input includes image', () => {
    expect(modelSupportsImagesFromInput(['text', 'image'])).toBe(true)
  })
  it('false when image is absent', () => {
    expect(modelSupportsImagesFromInput(['text'])).toBe(false)
  })
  it('true (permissive) when input is unknown', () => {
    expect(modelSupportsImagesFromInput(undefined)).toBe(true)
  })
})

describe('modelThinkingLevels', () => {
  it('falls back to off + common depths for an unlisted model', () => {
    expect(modelThinkingLevels('custom', 'openai', 'some-unlisted-model-xyz')).toEqual(['off', 'low', 'medium', 'high'])
  })
  it('always includes off', () => {
    expect(modelThinkingLevels('anthropic', undefined, 'claude-sonnet-4-5')).toContain('off')
  })
})

describe('effectiveThinkingLevel', () => {
  it('clamps a stored level to the unlisted-model fallback set', () => {
    // 'xhigh' isn't in the fallback set → clamps down to the highest available ('high').
    expect(effectiveThinkingLevel('custom', 'openai', 'unlisted-xyz', 'xhigh')).toBe('high')
  })
  it('keeps a supported stored level for an unlisted model', () => {
    expect(effectiveThinkingLevel('custom', 'openai', 'unlisted-xyz', 'low')).toBe('low')
  })
  it('defaults to high when nothing is stored', () => {
    expect(effectiveThinkingLevel('custom', 'openai', 'unlisted-xyz', undefined)).toBe('high')
  })
})
