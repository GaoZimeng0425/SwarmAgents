import type { ProviderInjection } from '@shared/types/provider'
import { describe, expect, it } from 'vitest'

import { applyAgentModel } from './model-override'

const base: ProviderInjection = {
  id: 'anthropic',
  apiStyle: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-1',
  thinkingLevel: 'high',
  fallbackProviders: [{ id: 'backup', apiStyle: 'openai', model: 'glm-4', apiKey: 'sk-2' }],
}

describe('applyAgentModel', () => {
  it('applies both model and thinkingLevel overrides', () => {
    const out = applyAgentModel(base, { model: 'claude-opus-4-8', thinkingLevel: 'xhigh' })
    expect(out.model).toBe('claude-opus-4-8')
    expect(out.thinkingLevel).toBe('xhigh')
  })

  it('applies thinkingLevel alone, preserving the inherited model', () => {
    const out = applyAgentModel(base, { thinkingLevel: 'off' })
    expect(out.model).toBe('claude-sonnet-4-5')
    expect(out.thinkingLevel).toBe('off')
  })

  it('preserves the resolved fallbackProviders chain and apiKey through the override', () => {
    const out = applyAgentModel(base, { model: 'claude-opus-4-8' })
    expect(out.apiKey).toBe('sk-1')
    expect(out.fallbackProviders).toEqual(base.fallbackProviders)
  })

  it('returns the same injection (identity) when the agent pins neither', () => {
    expect(applyAgentModel(base, {})).toBe(base)
  })
})
