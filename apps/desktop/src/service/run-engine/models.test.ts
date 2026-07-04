import { ANTHROPIC_MODEL_SUGGESTIONS, DEFAULT_CONTEXT_WINDOW } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { composeSystemPrompt, injectionSupportsImages, pricingToCost, resolveModel } from './models'

const custom = (over: Record<string, unknown> = {}) =>
  ({ id: 'c1', model: 'mystery-model', apiKey: 'k', apiStyle: 'openai', ...over }) as never

describe('resolveModel', () => {
  it('resolves a custom provider by apiStyle with the 200k default window', () => {
    const m = resolveModel(custom())
    expect(m.id).toBe('mystery-model')
    expect(m.api).toBe('openai-completions')
    expect(m.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('honors an explicit custom contextWindow override', () => {
    expect(resolveModel(custom({ contextWindow: 1_000_000 })).contextWindow).toBe(1_000_000)
  })

  it('looks a UUID-id custom provider up by apiStyle, never by id', () => {
    // Regression port (v1 agent-runner.test.ts 't-uuid'): resolveModel must not
    // treat the provider id as a pi-ai registry key.
    const m = resolveModel(custom({ id: '1ec9df3a-02f0-4d29-b83b-c21bc8644801', model: 'glm-4' }))
    expect(m.id).toBe('glm-4')
  })

  it('keeps the requested model id on the registry path too', () => {
    const m = resolveModel({
      id: 'anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: ANTHROPIC_MODEL_SUGGESTIONS[0],
      apiKey: 'k',
    } as never)
    expect(m.id).toBe(ANTHROPIC_MODEL_SUGGESTIONS[0])
  })

  it('applies custom pricing as the model cost', () => {
    const m = resolveModel(custom({ pricing: { inputPerM: 3, outputPerM: 15 } }))
    expect(m.cost).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('pricingToCost', () => {
  it('maps full pricing to the Model.cost shape', () => {
    expect(pricingToCost({ inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 1 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 1,
    })
  })

  it('defaults absent cache fields to 0', () => {
    expect(pricingToCost({ inputPerM: 3, outputPerM: 15 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe('injectionSupportsImages', () => {
  it('is true for an anthropic registry model (image-capable catalog entry)', () => {
    expect(
      injectionSupportsImages({
        id: 'anthropic',
        registry: 'anthropic',
        apiStyle: 'anthropic',
        model: ANTHROPIC_MODEL_SUGGESTIONS[0],
        apiKey: 'k',
      } as never)
    ).toBe(true)
  })
})

describe('composeSystemPrompt', () => {
  it('returns the base untouched with no context', () => {
    expect(composeSystemPrompt('base', {})).toBe('base')
  })

  it('prefixes the working directory', () => {
    expect(composeSystemPrompt('base', { cwd: '/w' })).toContain('Working directory: /w.')
  })

  it('prefixes the plan-mode constraint', () => {
    expect(composeSystemPrompt('base', { executionMode: 'plan' })).toContain('PLAN mode')
  })

  it('stacks cwd then plan mode before the base', () => {
    const s = composeSystemPrompt('base', { cwd: '/w', executionMode: 'plan' })
    expect(s.indexOf('Working directory')).toBeLessThan(s.indexOf('PLAN mode'))
    expect(s.endsWith('base')).toBe(true)
  })
})
