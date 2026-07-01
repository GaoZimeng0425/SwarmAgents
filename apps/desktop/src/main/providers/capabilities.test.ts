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
  it('falls back to off + common depths for an unlisted model (no registry)', () => {
    expect(modelThinkingLevels(undefined, 'openai', 'some-unlisted-model-xyz')).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ])
  })
  it('always includes off', () => {
    expect(modelThinkingLevels('anthropic', 'anthropic', 'claude-sonnet-4-5')).toContain('off')
  })

  it('derives real depths for a spec-matched custom GLM model (no registry)', () => {
    // minimal maps to null (disabled) → excluded; the rest are real depths.
    expect(modelThinkingLevels(undefined, 'openai', 'glm-5.2')).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
  })

  it('derives real depths for a spec-matched custom DeepSeek model', () => {
    // Only high/xhigh enable thinking; lower depths map to null → excluded.
    expect(modelThinkingLevels(undefined, 'openai', 'deepseek-v4-pro')).toEqual(['off', 'high', 'xhigh'])
  })

  it('exposes the full depth range for built-in Claude Opus 4.8 (registry path)', () => {
    expect(modelThinkingLevels('anthropic', 'anthropic', 'claude-opus-4-8')).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })
})

describe('effectiveThinkingLevel', () => {
  it('clamps a stored level to the unlisted-model fallback set', () => {
    // 'xhigh' isn't in the fallback set → clamps down to the highest available ('high').
    expect(effectiveThinkingLevel(undefined, 'openai', 'unlisted-xyz', 'xhigh')).toBe('high')
  })
  it('keeps a supported stored level for an unlisted model', () => {
    expect(effectiveThinkingLevel(undefined, 'openai', 'unlisted-xyz', 'low')).toBe('low')
  })
  it('defaults to high when nothing is stored', () => {
    expect(effectiveThinkingLevel(undefined, 'openai', 'unlisted-xyz', undefined)).toBe('high')
  })
})
