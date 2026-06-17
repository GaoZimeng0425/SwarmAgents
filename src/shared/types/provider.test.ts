import { describe, expect, it } from 'vitest'

import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  BuiltinProviderId,
  defaultProvidersStateOnDisk,
  findProviderRowView,
  OPENAI_MODEL_SUGGESTIONS,
  ProviderInjection,
  ProvidersStateOnDisk,
  ProvidersStateView,
  parsePersistedState,
} from './provider'

const genId = () => 'cust-1'

describe('provider schemas (v2)', () => {
  it('BuiltinProviderId accepts only anthropic and openai', () => {
    expect(BuiltinProviderId.parse('anthropic')).toBe('anthropic')
    expect(BuiltinProviderId.parse('openai')).toBe('openai')
    expect(() => BuiltinProviderId.parse('custom')).toThrow()
  })

  it('model suggestion lists contain expected entries', () => {
    expect(ANTHROPIC_MODEL_SUGGESTIONS).toContain('claude-opus-4-7')
    expect(OPENAI_MODEL_SUGGESTIONS).toContain('gpt-4o')
  })

  it('ProvidersStateOnDisk requires version 2 and builtins/custom shape', () => {
    const ok = ProvidersStateOnDisk.parse({
      version: 2,
      active: null,
      builtins: { anthropic: null, openai: null },
      custom: [],
    })
    expect(ok.version).toBe(2)
    expect(() =>
      ProvidersStateOnDisk.parse({ version: 1, active: null, providers: { anthropic: null, openai: null } })
    ).toThrow()
  })

  it('rejects an empty apiKey in a builtin slot', () => {
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 2,
        active: 'anthropic',
        builtins: { anthropic: { model: 'claude-sonnet-4-5', apiKey: '' }, openai: null },
        custom: [],
      })
    ).toThrow()
  })

  it('accepts custom providers with id, name and required apiStyle', () => {
    const v = ProvidersStateOnDisk.parse({
      version: 2,
      active: 'c1',
      builtins: { anthropic: null, openai: null },
      custom: [
        { id: 'c1', name: 'BigModel', model: 'glm-4', apiKey: 'sk-x', apiStyle: 'openai', baseUrl: 'https://x.com/v4' },
      ],
    })
    expect(v.custom[0].name).toBe('BigModel')
    expect(v.custom[0].apiStyle).toBe('openai')
  })

  it('rejects a customModels list that is too long', () => {
    const list = Array.from({ length: 51 }, (_, i) => `m${i}`)
    expect(() =>
      ProvidersStateOnDisk.parse({
        version: 2,
        active: null,
        builtins: { anthropic: { model: 'gpt-4o', apiKey: 'sk-x', customModels: list }, openai: null },
        custom: [],
      })
    ).toThrow()
  })

  it('ProvidersStateView uses hasKey and a custom array', () => {
    const v = ProvidersStateView.parse({
      active: 'anthropic',
      builtins: {
        anthropic: {
          model: 'claude-sonnet-4-5',
          hasKey: true,
          supportsImages: true,
          thinkingLevels: ['off', 'high'],
          thinkingLevel: 'high',
        },
        openai: null,
      },
      custom: [],
    })
    expect(v.builtins.anthropic?.hasKey).toBe(true)
  })

  it('migrates a legacy v1 file (custom slot → custom array entry)', () => {
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
    expect(migrated).not.toBeNull()
    expect(migrated?.version).toBe(2)
    expect(migrated?.builtins.anthropic?.apiKey).toBe('sk-a')
    expect(migrated?.custom).toHaveLength(1)
    expect(migrated?.custom[0].id).toBe('cust-1')
    expect(migrated?.active).toBe('cust-1') // active 'custom' now points at the migrated id
  })

  it('parsePersistedState returns a v2 file unchanged and null for garbage', () => {
    const v2 = defaultProvidersStateOnDisk()
    expect(parsePersistedState(v2, genId)).toEqual(v2)
    expect(parsePersistedState({ nonsense: true }, genId)).toBeNull()
  })

  it('defaultProvidersStateOnDisk returns an empty version-2 state', () => {
    const d = defaultProvidersStateOnDisk()
    expect(d.version).toBe(2)
    expect(d.active).toBeNull()
    expect(d.custom).toEqual([])
    expect(ProvidersStateOnDisk.parse(d)).toEqual(d)
  })

  it('ProviderInjection requires a non-empty apiKey and a string id', () => {
    expect(ProviderInjection.parse({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-x' })).toBeDefined()
    expect(ProviderInjection.parse({ id: 'cust-1', model: 'glm-4', apiKey: 'sk-x', apiStyle: 'openai' }).apiStyle).toBe(
      'openai'
    )
    expect(() => ProviderInjection.parse({ id: 'anthropic', model: 'm', apiKey: '' })).toThrow()
  })

  it('findProviderRowView resolves builtin and custom ids', () => {
    const view = ProvidersStateView.parse({
      active: null,
      builtins: {
        anthropic: {
          model: 'claude',
          hasKey: true,
          supportsImages: true,
          thinkingLevels: ['off'],
          thinkingLevel: 'off',
        },
        openai: null,
      },
      custom: [
        {
          id: 'c1',
          name: 'X',
          model: 'glm-4',
          hasKey: true,
          supportsImages: false,
          thinkingLevels: ['off'],
          thinkingLevel: 'off',
        },
      ],
    })
    expect(findProviderRowView(view, 'anthropic')?.model).toBe('claude')
    expect(findProviderRowView(view, 'c1')?.model).toBe('glm-4')
    expect(findProviderRowView(view, 'openai')).toBeNull()
    expect(findProviderRowView(view, null)).toBeNull()
  })
})
