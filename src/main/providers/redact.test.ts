import type { ProvidersStateOnDisk } from '@shared/types/provider'
import { describe, expect, it } from 'vitest'

import { toView } from './redact'

const base = (over: Partial<ProvidersStateOnDisk> = {}): ProvidersStateOnDisk => ({
  version: 2,
  active: null,
  builtins: { anthropic: null, openai: null },
  custom: [],
  ...over,
})

describe('toView', () => {
  it('replaces apiKey with hasKey:true when a builtin key is present', () => {
    const view = toView(
      base({
        active: 'anthropic',
        builtins: { anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-secret' }, openai: null },
      })
    )
    expect(view.active).toBe('anthropic')
    expect(view.builtins.anthropic).toEqual({
      model: 'claude-sonnet-4-5',
      hasKey: true,
      supportsImages: expect.any(Boolean),
      thinkingLevels: expect.any(Array),
      thinkingLevel: expect.any(String),
    })
    expect(view.builtins.openai).toBeNull()
  })

  it('keeps null builtins null and projects custom providers with id/name', () => {
    const view = toView(
      base({
        custom: [
          {
            id: 'c1',
            name: 'BigModel',
            model: 'glm-4',
            apiKey: 'sk-c',
            apiStyle: 'openai',
            baseUrl: 'https://x.com/v4',
          },
        ],
      })
    )
    expect(view.builtins.anthropic).toBeNull()
    expect(view.custom).toHaveLength(1)
    expect(view.custom[0]).toMatchObject({
      id: 'c1',
      name: 'BigModel',
      hasKey: true,
      baseUrl: 'https://x.com/v4',
      apiStyle: 'openai',
    })
  })

  it('threads customModels through and omits them when empty', () => {
    const view = toView(
      base({
        builtins: {
          anthropic: { model: 'claude-opus-4-7', apiKey: 'sk-a', customModels: [] },
          openai: { model: 'gpt-4o', apiKey: 'sk-o', customModels: ['deepseek-chat', 'deepseek-coder'] },
        },
      })
    )
    expect(view.builtins.anthropic?.customModels).toBeUndefined()
    expect(view.builtins.openai?.customModels).toEqual(['deepseek-chat', 'deepseek-coder'])
  })

  it('no apiKey field survives anywhere in the view (deep walk)', () => {
    const view = toView(
      base({
        builtins: {
          anthropic: { model: 'claude-opus-4-7', apiKey: 'sk-a' },
          openai: { model: 'gpt-4o', apiKey: 'sk-o' },
        },
        custom: [{ id: 'c1', name: 'X', model: 'glm-4', apiKey: 'sk-c', apiStyle: 'openai' }],
      })
    )
    const json = JSON.stringify(view)
    expect(json).not.toContain('sk-a')
    expect(json).not.toContain('sk-o')
    expect(json).not.toContain('sk-c')
    expect(json).not.toContain('"apiKey"')
  })
})
