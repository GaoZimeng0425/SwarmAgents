import { describe, expect, it } from 'vitest'

import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  defaultProvidersStateOnDisk,
  OPENAI_MODEL_SUGGESTIONS,
  ProviderId,
  ProviderInjection,
  ProvidersStateOnDisk,
  ProvidersStateView,
} from './provider'

describe('provider schemas', () => {
  it('ProviderId accepts anthropic, openai, and custom', () => {
    expect(ProviderId.parse('anthropic')).toBe('anthropic')
    expect(ProviderId.parse('openai')).toBe('openai')
    expect(ProviderId.parse('custom')).toBe('custom')
    expect(() => ProviderId.parse('gemini')).toThrow()
  })

  it('model suggestion lists contain expected entries', () => {
    expect(ANTHROPIC_MODEL_SUGGESTIONS).toContain('claude-opus-4-7')
    expect(ANTHROPIC_MODEL_SUGGESTIONS).toContain('claude-sonnet-4-5')
    expect(OPENAI_MODEL_SUGGESTIONS).toContain('gpt-4o')
    expect(OPENAI_MODEL_SUGGESTIONS).toContain('o1-mini')
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
      })
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
      })
    ).toThrow()
  })

  it('ProvidersStateOnDisk accepts custom model ids (free strings)', () => {
    const v = ProvidersStateOnDisk.parse({
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: { model: 'deepseek-chat', apiKey: 'sk-x' },
      },
    })
    expect(v.providers.openai?.model).toBe('deepseek-chat')
  })

  it('ProvidersStateOnDisk accepts an optional baseUrl on each row', () => {
    const v = ProvidersStateOnDisk.parse({
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: {
          model: 'deepseek-chat',
          apiKey: 'sk-x',
          baseUrl: 'https://api.deepseek.com',
        },
      },
    })
    expect(v.providers.openai?.baseUrl).toBe('https://api.deepseek.com')
  })

  it('ProvidersStateOnDisk accepts an optional customModels list', () => {
    const v = ProvidersStateOnDisk.parse({
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: {
          model: 'deepseek-chat',
          apiKey: 'sk-x',
          customModels: ['deepseek-chat', 'deepseek-coder'],
        },
      },
    })
    expect(v.providers.openai?.customModels).toEqual(['deepseek-chat', 'deepseek-coder'])
  })

  it('ProvidersStateOnDisk rejects a customModels list that is too long', () => {
    const list = Array.from({ length: 51 }, (_, i) => `m${i}`)
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 1,
        active: null,
        providers: {
          anthropic: null,
          openai: { model: 'gpt-4o', apiKey: 'sk-x', customModels: list },
        },
      })
    ).toThrow()
  })

  it('ProvidersStateOnDisk rejects a malformed baseUrl', () => {
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 1,
        active: 'openai',
        providers: {
          anthropic: null,
          openai: { model: 'gpt-4o', apiKey: 'sk-x', baseUrl: 'not a url' },
        },
      })
    ).toThrow()
  })

  it('ProvidersStateView mirrors structure but uses hasKey', () => {
    const v = ProvidersStateView.parse({
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', hasKey: true },
        openai: null,
        custom: null,
      },
    })
    expect(v.providers.anthropic?.hasKey).toBe(true)
  })

  it('ProvidersStateOnDisk back-fills a missing custom slot from legacy state', () => {
    const v = ProvidersStateOnDisk.parse({
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    })
    expect(v.providers.custom).toBeNull()
  })

  it('ProvidersStateOnDisk accepts the custom slot with apiStyle', () => {
    const v = ProvidersStateOnDisk.parse({
      version: 1,
      active: 'custom',
      providers: {
        anthropic: null,
        openai: null,
        custom: {
          model: 'deepseek-chat',
          apiKey: 'sk-x',
          baseUrl: 'https://api.deepseek.com',
          apiStyle: 'openai',
        },
      },
    })
    expect(v.providers.custom?.apiStyle).toBe('openai')
  })

  it('defaultProvidersStateOnDisk returns an empty version-1 state', () => {
    const d = defaultProvidersStateOnDisk()
    expect(d.version).toBe(1)
    expect(d.active).toBeNull()
    expect(d.providers.anthropic).toBeNull()
    expect(d.providers.openai).toBeNull()
    expect(d.providers.custom).toBeNull()
    expect(ProvidersStateOnDisk.parse(d)).toEqual(d)
  })

  it('ProviderInjection requires apiKey to be non-empty and accepts optional baseUrl', () => {
    expect(ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-x' })).toBeDefined()
    expect(
      ProviderInjection.parse({
        id: 'openai',
        model: 'deepseek-chat',
        apiKey: 'sk-x',
        baseUrl: 'https://api.deepseek.com',
      }).baseUrl
    ).toBe('https://api.deepseek.com')
    expect(() => ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '' })).toThrow()
  })

  it('ProviderInjection carries apiStyle for custom provider', () => {
    const v = ProviderInjection.parse({
      id: 'custom',
      model: 'deepseek-chat',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      apiStyle: 'openai',
    })
    expect(v.apiStyle).toBe('openai')
  })
})
