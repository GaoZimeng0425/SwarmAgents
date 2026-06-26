import { describe, expect, it } from 'vitest'

import { reasoningOverridesFor, reasoningSpecFor } from './models'

describe('reasoningSpecFor', () => {
  it('matches GLM ids to the zai thinking format', () => {
    expect(reasoningSpecFor('glm-5.2')?.compat?.thinkingFormat).toBe('zai')
    expect(reasoningSpecFor('GLM-4.7')?.compat?.thinkingFormat).toBe('zai')
  })

  it('matches DeepSeek ids to the deepseek thinking format', () => {
    expect(reasoningSpecFor('deepseek-v4-pro')?.compat?.thinkingFormat).toBe('deepseek')
  })

  it('matches MiMo ids (bare and HuggingFace-namespaced)', () => {
    expect(reasoningSpecFor('mimo-v2.5')?.reasoning).toBe(true)
    expect(reasoningSpecFor('XiaomiMiMo/MiMo-V2-Flash')?.reasoning).toBe(true)
    // MiMo reasons natively — no reasoning_effort knob and no special format.
    expect(reasoningSpecFor('mimo-v2.5')?.compat?.thinkingFormat).toBeUndefined()
    expect(reasoningSpecFor('mimo-v2.5')?.compat?.supportsReasoningEffort).toBe(false)
  })

  it('returns undefined for an unknown family', () => {
    expect(reasoningSpecFor('gpt-4o')).toBeUndefined()
    expect(reasoningSpecFor('claude-opus-4-7')).toBeUndefined()
  })
})

describe('reasoningOverridesFor', () => {
  it('maps GLM depths to wire values (xhigh → max)', () => {
    const o = reasoningOverridesFor('glm-5.2')
    expect(o?.reasoning).toBe(true)
    expect(o?.thinkingLevelMap).toEqual({
      minimal: null,
      low: 'high',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
    })
  })

  it('disables DeepSeek thinking below high', () => {
    const map = reasoningOverridesFor('deepseek-chat')?.thinkingLevelMap
    expect(map?.medium).toBeNull()
    expect(map?.high).toBe('high')
    expect(map?.xhigh).toBe('max')
  })

  it('omits compat and thinkingLevelMap keys when a spec lacks them', () => {
    const o = reasoningOverridesFor('mimo-v2.5')
    expect(o).toEqual({ reasoning: true, compat: { supportsReasoningEffort: false } })
    expect('thinkingLevelMap' in (o ?? {})).toBe(false)
  })

  it('returns undefined for an unknown family', () => {
    expect(reasoningOverridesFor('gpt-4o')).toBeUndefined()
  })
})
