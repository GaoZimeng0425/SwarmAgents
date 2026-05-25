import { describe, expect, it } from 'vitest'

import type { ProvidersStateOnDisk } from '@shared/types/provider'

import { toView } from './redact'

describe('toView', () => {
  it('replaces apiKey with hasKey:true when key is present', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-secret' },
        openai: null,
      },
    }
    const view = toView(state)
    expect(view.active).toBe('anthropic')
    expect(view.providers.anthropic).toEqual({
      model: 'claude-sonnet-4-5',
      hasKey: true,
    })
    expect(view.providers.openai).toBeNull()
  })

  it('keeps null providers null', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: null,
      providers: { anthropic: null, openai: null },
    }
    const view = toView(state)
    expect(view.providers.anthropic).toBeNull()
    expect(view.providers.openai).toBeNull()
  })

  it('no apiKey field survives anywhere in the view (deep walk)', () => {
    const state: ProvidersStateOnDisk = {
      version: 1,
      active: 'openai',
      providers: {
        anthropic: { model: 'claude-opus-4-7', apiKey: 'sk-a' },
        openai: { model: 'gpt-4o', apiKey: 'sk-o' },
      },
    }
    const view = toView(state)
    const json = JSON.stringify(view)
    expect(json).not.toContain('sk-a')
    expect(json).not.toContain('sk-o')
    expect(json).not.toContain('"apiKey"')
  })
})
