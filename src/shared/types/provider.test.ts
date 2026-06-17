import { describe, expect, it } from 'vitest'

import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  BUILTIN_DEFS,
  BuiltinProviderId,
  defaultProvidersStateOnDisk,
  OPENAI_MODEL_SUGGESTIONS,
  Provider,
  ProviderInjection,
  ProvidersStateOnDisk,
  ProvidersStateView,
  parsePersistedState,
  providerViewById,
} from './provider'

const genId = () => 'cust-1'

const builtinRow = (over: Record<string, unknown> = {}) => ({
  id: 'anthropic',
  name: 'Anthropic',
  registry: 'anthropic',
  apiStyle: 'anthropic',
  apiKey: 'sk-a',
  models: ['claude-sonnet-4-5'],
  model: 'claude-sonnet-4-5',
  ...over,
})

describe('provider schemas (v3)', () => {
  it('BuiltinProviderId accepts only anthropic and openai', () => {
    expect(BuiltinProviderId.parse('anthropic')).toBe('anthropic')
    expect(BuiltinProviderId.parse('openai')).toBe('openai')
    expect(() => BuiltinProviderId.parse('custom')).toThrow()
  })

  it('BUILTIN_DEFS concentrates builtin identity (name, registry, apiStyle, suggestions)', () => {
    expect(BUILTIN_DEFS.anthropic.registry).toBe('anthropic')
    expect(BUILTIN_DEFS.anthropic.apiStyle).toBe('anthropic')
    expect(BUILTIN_DEFS.anthropic.name).toBe('Anthropic')
    expect(BUILTIN_DEFS.anthropic.suggestions).toEqual([...ANTHROPIC_MODEL_SUGGESTIONS])
    expect(BUILTIN_DEFS.openai.suggestions).toEqual([...OPENAI_MODEL_SUGGESTIONS])
  })

  it('Provider requires models[] (>=1), a selected model, and a non-empty apiKey', () => {
    expect(Provider.parse(builtinRow()).models).toEqual(['claude-sonnet-4-5'])
    expect(() => Provider.parse(builtinRow({ models: [] }))).toThrow()
    expect(() => Provider.parse(builtinRow({ apiKey: '' }))).toThrow()
    // registry is optional — a custom provider omits it
    const custom = Provider.parse({
      id: 'c1',
      name: 'BigModel',
      apiStyle: 'openai',
      apiKey: 'sk-x',
      models: ['glm-4'],
      model: 'glm-4',
      baseUrl: 'https://x.com/v4',
    })
    expect(custom.registry).toBeUndefined()
    expect(custom.apiStyle).toBe('openai')
  })

  it('Provider rejects a models list longer than 50', () => {
    const models = Array.from({ length: 51 }, (_, i) => `m${i}`)
    expect(() => Provider.parse(builtinRow({ models, model: 'm0' }))).toThrow()
  })

  it('ProvidersStateOnDisk is version 3 with a flat providers[]', () => {
    const ok = ProvidersStateOnDisk.parse({ version: 3, active: null, providers: [] })
    expect(ok.version).toBe(3)
    expect(ok.providers).toEqual([])
    // old v2 shape no longer validates as current
    expect(() =>
      ProvidersStateOnDisk.parse({ version: 2, active: null, builtins: { anthropic: null, openai: null }, custom: [] })
    ).toThrow()
  })

  it('migrates a legacy v2 file (builtins{} + custom[]) into a flat providers[]', () => {
    const migrated = parsePersistedState(
      {
        version: 2,
        active: 'c1',
        builtins: {
          anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-a', customModels: ['claude-haiku-4-5'] },
          openai: null,
        },
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
      },
      genId
    )
    expect(migrated?.version).toBe(3)
    expect(migrated?.active).toBe('c1')
    const anthropic = migrated?.providers.find((p) => p.id === 'anthropic')
    expect(anthropic?.registry).toBe('anthropic')
    expect(anthropic?.apiStyle).toBe('anthropic')
    expect(anthropic?.name).toBe('Anthropic')
    expect(anthropic?.models).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5'])
    expect(anthropic?.model).toBe('claude-sonnet-4-5')
    expect(migrated?.providers.find((p) => p.id === 'openai')).toBeUndefined()
    const custom = migrated?.providers.find((p) => p.id === 'c1')
    expect(custom?.registry).toBeUndefined()
    expect(custom?.apiStyle).toBe('openai')
    expect(custom?.models).toEqual(['glm-4'])
  })

  it('migrates a legacy v1 file straight through to v3', () => {
    const migrated = parsePersistedState(
      {
        version: 1,
        active: 'custom',
        providers: {
          anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-a' },
          openai: null,
          custom: { model: 'glm-4', apiKey: 'sk-c', baseUrl: 'https://x.com/v4', apiStyle: 'openai' },
        },
      },
      genId
    )
    expect(migrated?.version).toBe(3)
    // the v1 'custom' slot became a custom provider with the generated id, and active follows it
    expect(migrated?.active).toBe('cust-1')
    expect(migrated?.providers.find((p) => p.id === 'cust-1')?.model).toBe('glm-4')
    expect(migrated?.providers.find((p) => p.id === 'anthropic')?.registry).toBe('anthropic')
  })

  it('parsePersistedState returns a v3 file unchanged and null for garbage', () => {
    const v3 = defaultProvidersStateOnDisk()
    expect(parsePersistedState(v3, genId)).toEqual(v3)
    expect(parsePersistedState({ nonsense: true }, genId)).toBeNull()
  })

  it('defaultProvidersStateOnDisk returns an empty version-3 state', () => {
    const d = defaultProvidersStateOnDisk()
    expect(d.version).toBe(3)
    expect(d.active).toBeNull()
    expect(d.providers).toEqual([])
    expect(ProvidersStateOnDisk.parse(d)).toEqual(d)
  })

  it('ProviderInjection requires apiKey + apiStyle, with optional registry', () => {
    const builtin = ProviderInjection.parse({
      id: 'anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-x',
    })
    expect(builtin.registry).toBe('anthropic')
    const custom = ProviderInjection.parse({ id: 'c1', apiStyle: 'openai', model: 'glm-4', apiKey: 'sk-x' })
    expect(custom.registry).toBeUndefined()
    expect(custom.apiStyle).toBe('openai')
    expect(() => ProviderInjection.parse({ id: 'anthropic', apiStyle: 'anthropic', model: 'm', apiKey: '' })).toThrow()
    expect(() => ProviderInjection.parse({ id: 'c1', model: 'm', apiKey: 'k' })).toThrow() // apiStyle required
  })

  it('providerViewById finds a provider in the flat view', () => {
    const view = ProvidersStateView.parse({
      active: null,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          registry: 'anthropic',
          apiStyle: 'anthropic',
          hasKey: true,
          supportsImages: true,
          models: ['claude'],
          model: 'claude',
          thinkingLevels: ['off'],
          thinkingLevel: 'off',
        },
        {
          id: 'c1',
          name: 'X',
          apiStyle: 'openai',
          hasKey: true,
          supportsImages: false,
          models: ['glm-4'],
          model: 'glm-4',
          thinkingLevels: ['off'],
          thinkingLevel: 'off',
        },
      ],
    })
    expect(providerViewById(view, 'anthropic')?.model).toBe('claude')
    expect(providerViewById(view, 'c1')?.model).toBe('glm-4')
    expect(providerViewById(view, 'openai')).toBeNull()
    expect(providerViewById(view, null)).toBeNull()
  })
})
