import type { Provider, ProvidersStateOnDisk } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { toView } from './redact'

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 'anthropic',
  name: 'Anthropic',
  registry: 'anthropic',
  apiStyle: 'anthropic',
  apiKey: 'sk-secret',
  models: ['claude-sonnet-4-5'],
  model: 'claude-sonnet-4-5',
  ...over,
})

const base = (providers: Provider[], active: string | null = null): ProvidersStateOnDisk => ({
  version: 4,
  active,
  providers,
})

describe('toView', () => {
  it('replaces apiKey with hasKey:true and carries identity fields', () => {
    const view = toView(base([provider()], 'anthropic'))
    expect(view.active).toBe('anthropic')
    expect(view.providers[0]).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: 'claude-sonnet-4-5',
      models: ['claude-sonnet-4-5'],
      hasKey: true,
      supportsImages: expect.any(Boolean),
      thinkingLevels: expect.any(Array),
      thinkingLevel: expect.any(String),
    })
  })

  it('projects a custom provider (no registry) with its models and apiStyle', () => {
    const view = toView(
      base([
        provider({
          id: 'c1',
          name: 'BigModel',
          registry: undefined,
          apiStyle: 'openai',
          apiKey: 'sk-c',
          models: ['glm-4', 'glm-4-air'],
          model: 'glm-4',
          baseUrl: 'https://x.com/v4',
        }),
      ])
    )
    expect(view.providers[0]).toMatchObject({
      id: 'c1',
      name: 'BigModel',
      hasKey: true,
      apiStyle: 'openai',
      baseUrl: 'https://x.com/v4',
      models: ['glm-4', 'glm-4-air'],
    })
    expect(view.providers[0].registry).toBeUndefined()
  })

  it('no apiKey field survives anywhere in the view (deep walk)', () => {
    const view = toView(
      base([
        provider({ id: 'anthropic', apiKey: 'sk-a' }),
        provider({
          id: 'c1',
          name: 'X',
          registry: undefined,
          apiStyle: 'openai',
          apiKey: 'sk-c',
          models: ['glm-4'],
          model: 'glm-4',
        }),
      ])
    )
    const json = JSON.stringify(view)
    expect(json).not.toContain('sk-a')
    expect(json).not.toContain('sk-c')
    expect(json).not.toContain('"apiKey"')
  })
})
