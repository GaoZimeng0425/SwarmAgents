import type { Provider, ProvidersStateOnDisk } from '@shared/types/provider'
import { describe, expect, it, vi } from 'vitest'

import { createService } from './service'
import type { Store } from './store'

function makeStore(initial: ProvidersStateOnDisk): Store & { saved: ProvidersStateOnDisk[] } {
  const saved: ProvidersStateOnDisk[] = []
  let current = initial
  return {
    saved,
    load: vi.fn(async () => current),
    loadOrRecover: vi.fn(async () => ({ ok: true as const, state: current })),
    save: vi.fn(async (s: ProvidersStateOnDisk) => {
      saved.push(s)
      current = s
    }),
  }
}

const empty: ProvidersStateOnDisk = { version: 4, active: null, providers: [] }

const anthropic: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  registry: 'anthropic',
  apiStyle: 'anthropic',
  apiKey: 'sk-1',
  models: ['claude-sonnet-4-5'],
  model: 'claude-sonnet-4-5',
}

const customRow: Provider = {
  id: 'c1',
  name: 'BigModel',
  apiStyle: 'openai',
  apiKey: 'sk-c',
  models: ['glm-4'],
  model: 'glm-4',
  baseUrl: 'https://x.com/v4',
}

const state = (over: Partial<ProvidersStateOnDisk> = {}): ProvidersStateOnDisk => ({ ...empty, ...over })
const find = (s: ProvidersStateOnDisk, id: string) => s.providers.find((p) => p.id === id)

describe('service (v4)', () => {
  it('init populates state and view from the store', async () => {
    const svc = await createService({ store: makeStore(state({ active: 'anthropic', providers: [anthropic] })) })
    expect(svc.getState().active).toBe('anthropic')
    expect(svc.getView().providers.find((p) => p.id === 'anthropic')?.hasKey).toBe(true)
  })

  it('setKey materializes a builtin from BUILTIN_DEFS on first use', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const calls: unknown[] = []
    svc.onStateChanged((v) => calls.push(v))
    expect(await svc.setKey('anthropic', 'sk-new')).toEqual({ ok: true })
    const created = find(store.saved[0], 'anthropic')
    expect(created).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      apiKey: 'sk-new',
      model: 'claude-opus-4-7',
      models: ['claude-opus-4-7'],
    })
    expect(calls).toHaveLength(1)
  })

  it('setKey rejects empty / newline / oversize keys', async () => {
    const svc = await createService({ store: makeStore(empty) })
    expect(await svc.setKey('anthropic', '')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setKey('anthropic', 'a\nb')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setKey('anthropic', 'x'.repeat(5000))).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setKey preserves an existing provider model; rejects an unknown non-builtin id', async () => {
    const svc = await createService({
      store: makeStore(state({ providers: [{ ...anthropic, model: 'claude-opus-4-7', models: ['claude-opus-4-7'] }] })),
    })
    await svc.setKey('anthropic', 'new')
    expect(find(svc.getState(), 'anthropic')?.model).toBe('claude-opus-4-7')
    expect(find(svc.getState(), 'anthropic')?.apiKey).toBe('new')
    await svc.setKey('openai', 'gpt-key')
    expect(find(svc.getState(), 'openai')?.model).toBe('gpt-4o')
    expect(await svc.setKey('nope', 'k')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('clearKey removes a builtin but is invalid for custom providers', async () => {
    const svc = await createService({
      store: makeStore(state({ active: 'anthropic', providers: [anthropic, customRow] })),
    })
    await svc.clearKey('anthropic')
    expect(find(svc.getState(), 'anthropic')).toBeUndefined()
    expect(svc.getState().active).toBeNull() // demoted
    expect(await svc.clearKey('c1')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setActive accepts null and configured ids; rejects unknown/unconfigured', async () => {
    const svc = await createService({ store: makeStore(state({ providers: [anthropic, customRow] })) })
    expect((await svc.setActive('anthropic')).ok).toBe(true)
    expect((await svc.setActive('c1')).ok).toBe(true)
    expect((await svc.setActive(null)).ok).toBe(true)
    expect(await svc.setActive('openai')).toMatchObject({ ok: false, code: 'invalid' }) // not configured
    expect(await svc.setActive('nope')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setModel updates the selected model and adds it to the list if new; validates', async () => {
    const svc = await createService({ store: makeStore(state({ active: 'anthropic', providers: [anthropic] })) })
    expect((await svc.setModel('anthropic', 'claude-opus-4-7')).ok).toBe(true)
    const p = find(svc.getState(), 'anthropic')
    expect(p?.model).toBe('claude-opus-4-7')
    expect(p?.models).toContain('claude-opus-4-7')
    expect(await svc.setModel('anthropic', '')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setModel('openai', 'gpt-4o')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setThinkingLevel persists and threads into the injection', async () => {
    const svc = await createService({ store: makeStore(state({ active: 'anthropic', providers: [anthropic] })) })
    expect((await svc.setThinkingLevel('anthropic', 'low')).ok).toBe(true)
    expect(find(svc.getState(), 'anthropic')?.thinkingLevel).toBe('low')
    expect(svc.getInjection()).toMatchObject({ thinkingLevel: 'low' })
  })

  it('setBaseUrl normalizes, strips trailing slash and pasted endpoint suffixes', async () => {
    const openai: Provider = {
      id: 'openai',
      name: 'OpenAI',
      registry: 'openai',
      apiStyle: 'openai',
      apiKey: 'sk-x',
      models: ['gpt-4o'],
      model: 'gpt-4o',
    }
    const svc = await createService({ store: makeStore(state({ providers: [openai] })) })
    await svc.setBaseUrl('openai', 'https://api.deepseek.com/')
    expect(find(svc.getState(), 'openai')?.baseUrl).toBe('https://api.deepseek.com')
    await svc.setBaseUrl('openai', 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(find(svc.getState(), 'openai')?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    await svc.setBaseUrl('openai', '')
    expect(find(svc.getState(), 'openai')?.baseUrl).toBeUndefined()
    expect(await svc.setBaseUrl('openai', 'ftp://x.com')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('addCustomModel / removeCustomModel manage the models list; cannot remove the selected', async () => {
    const svc = await createService({ store: makeStore(state({ providers: [customRow] })) })
    expect((await svc.addCustomModel('c1', 'glm-4-flash')).ok).toBe(true)
    expect(find(svc.getState(), 'c1')?.models).toEqual(['glm-4', 'glm-4-flash'])
    expect((await svc.addCustomModel('c1', 'glm-4-flash')).ok).toBe(true) // idempotent
    expect(find(svc.getState(), 'c1')?.models).toEqual(['glm-4', 'glm-4-flash'])
    await svc.removeCustomModel('c1', 'glm-4-flash')
    expect(find(svc.getState(), 'c1')?.models).toEqual(['glm-4'])
    // selected model cannot be removed (would leave selection dangling)
    expect(await svc.removeCustomModel('c1', 'glm-4')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('addCustomProvider creates an entry with a generated id and full model list', async () => {
    const svc = await createService({ store: makeStore(empty) })
    const r = await svc.addCustomProvider({
      name: 'BigModel',
      apiKey: 'sk-c',
      apiStyle: 'openai',
      baseUrl: 'https://x.com/v4/',
      models: ['glm-4', 'glm-4-flash'],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = find(svc.getState(), r.id)
    expect(c?.name).toBe('BigModel')
    expect(c?.registry).toBeUndefined()
    expect(c?.model).toBe('glm-4')
    expect(c?.models).toEqual(['glm-4', 'glm-4-flash'])
    expect(c?.baseUrl).toBe('https://x.com/v4')
  })

  it('addCustomProvider validates name, key, apiStyle and at least one model', async () => {
    const svc = await createService({ store: makeStore(empty) })
    expect(await svc.addCustomProvider({ name: '', apiKey: 'k', apiStyle: 'openai', models: ['m'] })).toMatchObject({
      ok: false,
    })
    expect(await svc.addCustomProvider({ name: 'X', apiKey: '', apiStyle: 'openai', models: ['m'] })).toMatchObject({
      ok: false,
    })
    expect(await svc.addCustomProvider({ name: 'X', apiKey: 'k', apiStyle: 'openai', models: [] })).toMatchObject({
      ok: false,
    })
  })

  it('removeCustomProvider deletes the entry and demotes active; invalid on builtins', async () => {
    const svc = await createService({ store: makeStore(state({ active: 'c1', providers: [anthropic, customRow] })) })
    expect((await svc.removeCustomProvider('c1')).ok).toBe(true)
    expect(find(svc.getState(), 'c1')).toBeUndefined()
    expect(svc.getState().active).toBeNull()
    expect(await svc.removeCustomProvider('c1')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.removeCustomProvider('anthropic')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('renameCustomProvider updates the name; rejects builtins and empty', async () => {
    const svc = await createService({ store: makeStore(state({ providers: [anthropic, customRow] })) })
    expect((await svc.renameCustomProvider('c1', 'Zhipu')).ok).toBe(true)
    expect(find(svc.getState(), 'c1')?.name).toBe('Zhipu')
    expect(await svc.renameCustomProvider('c1', '')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.renameCustomProvider('anthropic', 'X')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setApiStyle applies to custom providers and rejects on builtins', async () => {
    const svc = await createService({
      store: makeStore(state({ active: 'anthropic', providers: [anthropic, customRow] })),
    })
    expect((await svc.setApiStyle('c1', 'anthropic')).ok).toBe(true)
    expect(find(svc.getState(), 'c1')?.apiStyle).toBe('anthropic')
    expect(await svc.setApiStyle('anthropic', 'openai')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('getInjection: builtin carries registry + apiStyle; custom threads baseUrl + modelMeta', async () => {
    const svc = await createService({
      store: makeStore(
        state({
          active: 'anthropic',
          providers: [
            { ...anthropic, model: 'claude-haiku-4-5', models: ['claude-haiku-4-5'], apiKey: 'sk-y' },
            { ...customRow, modelMeta: { 'glm-4': { contextWindow: 1_000_000 } } },
          ],
        })
      ),
    })
    expect(svc.getInjection()).toEqual({
      id: 'anthropic',
      registry: 'anthropic',
      apiStyle: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-y',
    })

    await svc.setActive('c1')
    expect(svc.getInjection()).toEqual({
      id: 'c1',
      apiStyle: 'openai',
      model: 'glm-4',
      apiKey: 'sk-c',
      baseUrl: 'https://x.com/v4',
      contextWindow: 1_000_000,
    })
  })

  it('getInjection returns null with no active provider', async () => {
    const svc = await createService({ store: makeStore(empty) })
    expect(svc.getInjection()).toBeNull()
  })

  it('getInjection resolves fallbackProviderIds into an ordered fallbackProviders chain, skipping unknown + self', async () => {
    const primary: Provider = { ...anthropic, apiKey: 'sk-y', fallbackProviderIds: ['c1', 'ghost', 'anthropic'] }
    const svc = await createService({
      store: makeStore(state({ active: 'anthropic', providers: [primary, customRow] })),
    })
    const inj = svc.getInjection()
    expect(inj).toMatchObject({ id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-y' })
    // 'ghost' (unknown) and 'anthropic' (self) dropped; only c1 resolves.
    expect(inj?.fallbackProviders).toEqual([
      { id: 'c1', apiStyle: 'openai', model: 'glm-4', apiKey: 'sk-c', baseUrl: 'https://x.com/v4' },
    ])
  })

  it('getInjection omits fallbackProviders when none are configured', async () => {
    const svc = await createService({ store: makeStore(state({ active: 'anthropic', providers: [anthropic] })) })
    expect(svc.getInjection()).not.toHaveProperty('fallbackProviders')
  })

  it('setFallbackProviderIds dedupes, drops self + unknown ids, and clears on empty', async () => {
    const svc = await createService({
      store: makeStore(state({ active: 'anthropic', providers: [anthropic, customRow] })),
    })

    expect((await svc.setFallbackProviderIds('anthropic', ['c1', 'c1', 'anthropic', 'ghost'])).ok).toBe(true)
    expect(find(svc.getState(), 'anthropic')?.fallbackProviderIds).toEqual(['c1'])
    // Surfaced to the renderer view too.
    expect(svc.getView().providers.find((p) => p.id === 'anthropic')?.fallbackProviderIds).toEqual(['c1'])

    // Empty (or fully-sanitized-away) clears the field.
    expect((await svc.setFallbackProviderIds('anthropic', ['anthropic'])).ok).toBe(true)
    expect(find(svc.getState(), 'anthropic')?.fallbackProviderIds).toBeUndefined()

    // Unknown target provider is rejected.
    expect((await svc.setFallbackProviderIds('nope', ['c1'])).ok).toBe(false)
  })

  it('in-memory state does not advance when store.save throws', async () => {
    const store = makeStore(empty)
    store.save = vi.fn(async () => {
      throw new Error('disk full')
    })
    const svc = await createService({ store })
    expect(await svc.setKey('anthropic', 'sk-x')).toEqual({ ok: false, code: 'persist_failed', message: 'disk full' })
    expect(find(svc.getState(), 'anthropic')).toBeUndefined()
  })
})

describe('per-model metadata (v4)', () => {
  it('setModelContextWindow sets and clears per-model contextWindow on custom providers', async () => {
    const store = makeStore(state({ active: 'c1', providers: [customRow] }))
    const svc = await createService({ store })
    expect(await svc.setModelContextWindow('c1', 'glm-4', 500_000)).toEqual({ ok: true })
    expect(find(svc.getState(), 'c1')?.modelMeta?.['glm-4']?.contextWindow).toBe(500_000)
    expect(await svc.setModelContextWindow('c1', 'glm-4', null)).toEqual({ ok: true })
    expect(find(svc.getState(), 'c1')?.modelMeta?.['glm-4']).toBeUndefined()
  })

  it('setModelContextWindow rejects built-ins and unknown models', async () => {
    const svc = await createService({ store: makeStore(state({ providers: [anthropic, customRow] })) })
    expect((await svc.setModelContextWindow('anthropic', 'claude-sonnet-4-5', 1)).ok).toBe(false)
    expect((await svc.setModelContextWindow('c1', 'not-a-model', 1)).ok).toBe(false)
  })

  it('mergeModelMeta merges pulled fields, keeps untouched models, rejects built-ins', async () => {
    const row = { ...customRow, models: ['glm-4', 'glm-3'], modelMeta: { 'glm-4': { contextWindow: 1 } } }
    const svc = await createService({ store: makeStore(state({ providers: [row] })) })
    const r = await svc.mergeModelMeta('c1', {
      'glm-4': { pricing: { inputPerM: 3, outputPerM: 15 } },
      'glm-3': { contextWindow: 8000 },
      unknown: { contextWindow: 9 }, // not in models -> ignored
    })
    expect(r.ok).toBe(true)
    const meta = find(svc.getState(), 'c1')?.modelMeta
    expect(meta?.['glm-4']).toEqual({ contextWindow: 1, pricing: { inputPerM: 3, outputPerM: 15 } })
    expect(meta?.['glm-3']).toEqual({ contextWindow: 8000 })
    expect(meta?.['unknown']).toBeUndefined()
    expect((await svc.mergeModelMeta('anthropic', {})).ok).toBe(false)
  })

  it('getInjection carries the active model contextWindow + pricing from modelMeta', async () => {
    const row = {
      ...customRow,
      modelMeta: { 'glm-4': { contextWindow: 256000, pricing: { inputPerM: 1, outputPerM: 2 } } },
    }
    const svc = await createService({ store: makeStore(state({ active: 'c1', providers: [row] })) })
    const inj = svc.getInjection()
    expect(inj?.contextWindow).toBe(256000)
    expect(inj?.pricing).toEqual({ inputPerM: 1, outputPerM: 2 })
  })

  it('mergeModelMeta drops modelMeta entirely when all incoming keys are unknown', async () => {
    const store = makeStore(state({ providers: [customRow] }))
    const svc = await createService({ store })
    // customRow has no prior modelMeta; 'unknown-model' is not in models -> all ignored
    const r = await svc.mergeModelMeta('c1', { 'unknown-model': { contextWindow: 9 } })
    expect(r.ok).toBe(true)
    expect(find(svc.getState(), 'c1')?.modelMeta).toBeUndefined()
  })
})
