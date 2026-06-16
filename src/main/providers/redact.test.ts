import type { ProvidersStateOnDisk } from '@shared/types/provider'
import { describe, expect, it } from 'vitest'

import { toView } from './redact'

describe('toView', () => {
  it('replaces apiKey with hasKey:true when key is present', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-secret' },
        openai: null,
        custom: null,
      },
    }
    const view = toView(state)
    expect(view.active).toBe('anthropic')
    expect(view.providers.anthropic).toEqual({
      model: 'claude-sonnet-4-5',
      hasKey: true,
      supportsImages: expect.any(Boolean),
      thinkingLevels: expect.any(Array),
      thinkingLevel: expect.any(String),
    })
    expect(view.providers.openai).toBeNull()
  })

  it('keeps null providers null', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null, custom: null },
    }
    const view = toView(state)
    expect(view.providers.anthropic).toBeNull()
    expect(view.providers.openai).toBeNull()
  })

  it('threads baseUrl through to the view when present', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: {
          model: 'deepseek-chat',
          apiKey: 'sk-secret',
          baseUrl: 'https://api.deepseek.com',
        },
        custom: null,
      },
    }
    const view = toView(state)
    expect(view.providers.openai).toEqual({
      model: 'deepseek-chat',
      hasKey: true,
      supportsImages: expect.any(Boolean),
      thinkingLevels: expect.any(Array),
      thinkingLevel: expect.any(String),
      baseUrl: 'https://api.deepseek.com',
    })
  })

  it('threads customModels through to the view when present', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: {
          model: 'deepseek-chat',
          apiKey: 'sk-x',
          customModels: ['deepseek-chat', 'deepseek-coder'],
        },
        custom: null,
      },
    }
    const view = toView(state)
    expect(view.providers.openai?.customModels).toEqual(['deepseek-chat', 'deepseek-coder'])
  })

  it('omits customModels in the view when empty or undefined', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: null,
      providers: {
        anthropic: { model: 'claude-opus-4-7', apiKey: 'sk-a', customModels: [] },
        openai: { model: 'gpt-4o', apiKey: 'sk-o' },
        custom: null,
      },
    }
    const view = toView(state)
    expect(view.providers.anthropic?.customModels).toBeUndefined()
    expect(view.providers.openai?.customModels).toBeUndefined()
  })

  it('no apiKey field survives anywhere in the view (deep walk)', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'openai',
      providers: {
        anthropic: { model: 'claude-opus-4-7', apiKey: 'sk-a' },
        openai: { model: 'gpt-4o', apiKey: 'sk-o' },
        custom: null,
      },
    }
    const view = toView(state)
    const json = JSON.stringify(view)
    expect(json).not.toContain('sk-a')
    expect(json).not.toContain('sk-o')
    expect(json).not.toContain('"apiKey"')
  })
})
