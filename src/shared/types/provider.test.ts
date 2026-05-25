import { describe, expect, it } from 'vitest'

import {
  ProviderId,
  AnthropicModel,
  OpenAIModel,
  ProvidersStateOnDisk,
  ProvidersStateView,
  defaultProvidersStateOnDisk,
  ProviderInjection,
} from './provider'

describe('provider schemas', () => {
  it('ProviderId accepts anthropic and openai', () => {
    expect(ProviderId.parse('anthropic')).toBe('anthropic')
    expect(ProviderId.parse('openai')).toBe('openai')
    expect(() => ProviderId.parse('gemini')).toThrow()
  })

  it('AnthropicModel enum covers expected models', () => {
    for (const m of [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]) {
      expect(AnthropicModel.parse(m)).toBe(m)
    }
    expect(() => AnthropicModel.parse('gpt-4o')).toThrow()
  })

  it('OpenAIModel enum covers expected models', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini']) {
      expect(OpenAIModel.parse(m)).toBe(m)
    }
    expect(() => OpenAIModel.parse('claude-opus-4-7')).toThrow()
  })

  it('ProvidersStateOnDisk requires version 1', () => {
    const ok = ProvidersStateOnDisk.parse({
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    })
    expect(ok.version).toBe(1)
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 2,
        active: null,
        providers: { anthropic: null, openai: null },
      }),
    ).toThrow()
  })

  it('ProvidersStateOnDisk rejects empty apiKey', () => {
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 1,
        active: 'anthropic',
        providers: {
          anthropic: { model: 'claude-sonnet-4-5', apiKey: '' },
          openai: null,
        },
      }),
    ).toThrow()
  })

  it('ProvidersStateView mirrors structure but uses hasKey', () => {
    const v = ProvidersStateView.parse({
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', hasKey: true },
        openai: null,
      },
    })
    expect(v.providers.anthropic?.hasKey).toBe(true)
  })

  it('defaultProvidersStateOnDisk returns an empty version-1 state', () => {
    const d = defaultProvidersStateOnDisk()
    expect(d.version).toBe(1)
    expect(d.active).toBeNull()
    expect(d.providers.anthropic).toBeNull()
    expect(d.providers.openai).toBeNull()
    expect(ProvidersStateOnDisk.parse(d)).toEqual(d)
  })

  it('ProviderInjection requires apiKey to be non-empty', () => {
    expect(
      ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-x' }),
    ).toBeDefined()
    expect(() =>
      ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '' }),
    ).toThrow()
  })
})
