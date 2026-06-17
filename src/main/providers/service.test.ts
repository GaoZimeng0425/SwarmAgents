import type { ProvidersStateOnDisk } from '@shared/types/provider'
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

const empty: ProvidersStateOnDisk = {
  version: 2,
  active: null,
  builtins: { anthropic: null, openai: null },
  custom: [],
}

const withBuiltin = (over: Partial<ProvidersStateOnDisk> = {}): ProvidersStateOnDisk => ({
  version: 2,
  active: 'anthropic',
  builtins: { anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-1' }, openai: null },
  custom: [],
  ...over,
})

const customRow = {
  id: 'c1',
  name: 'BigModel',
  model: 'glm-4',
  apiKey: 'sk-c',
  apiStyle: 'openai' as const,
  baseUrl: 'https://x.com/v4',
}

describe('service (v2)', () => {
  it('init populates state and view from the store', async () => {
    const svc = await createService({ store: makeStore(withBuiltin()) })
    expect(svc.getState().active).toBe('anthropic')
    expect(svc.getView().builtins.anthropic?.hasKey).toBe(true)
  })

  it('setKey on a builtin persists and broadcasts', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const calls: unknown[] = []
    svc.onStateChanged((v) => calls.push(v))
    expect(await svc.setKey('anthropic', 'sk-new')).toEqual({ ok: true })
    expect(store.saved[0].builtins.anthropic?.apiKey).toBe('sk-new')
    expect(calls).toHaveLength(1)
  })

  it('setKey rejects empty / newline / oversize keys', async () => {
    const svc = await createService({ store: makeStore(empty) })
    expect(await svc.setKey('anthropic', '')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setKey('anthropic', 'a\nb')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setKey('anthropic', 'x'.repeat(5000))).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setKey preserves an existing model and defaults it otherwise', async () => {
    const svc = await createService({
      store: makeStore({
        ...empty,
        builtins: { anthropic: { model: 'claude-opus-4-7', apiKey: 'old' }, openai: null },
      }),
    })
    await svc.setKey('anthropic', 'new')
    expect(svc.getState().builtins.anthropic?.model).toBe('claude-opus-4-7')
    await svc.setKey('openai', 'gpt-key')
    expect(svc.getState().builtins.openai?.model).toBe('gpt-4o')
  })

  it('clearKey nulls a builtin but is invalid for custom providers', async () => {
    const svc = await createService({ store: makeStore({ ...empty, custom: [customRow] }) })
    await svc.clearKey('anthropic')
    expect(svc.getState().builtins.anthropic).toBeNull()
    expect(await svc.clearKey('c1')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setActive accepts null, builtin ids, and known custom ids; rejects unknown', async () => {
    const svc = await createService({ store: makeStore({ ...empty, custom: [customRow] }) })
    expect((await svc.setActive('openai')).ok).toBe(true)
    expect((await svc.setActive('c1')).ok).toBe(true)
    expect((await svc.setActive(null)).ok).toBe(true)
    expect(await svc.setActive('nope')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setModel updates the row; empty is invalid; unconfigured is invalid', async () => {
    const svc = await createService({ store: makeStore(withBuiltin()) })
    expect((await svc.setModel('anthropic', 'claude-opus-4-7')).ok).toBe(true)
    expect(svc.getState().builtins.anthropic?.model).toBe('claude-opus-4-7')
    expect(await svc.setModel('anthropic', '')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setModel('openai', 'gpt-4o')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setThinkingLevel persists and threads into the injection', async () => {
    const svc = await createService({ store: makeStore(withBuiltin()) })
    expect((await svc.setThinkingLevel('anthropic', 'low')).ok).toBe(true)
    expect(svc.getState().builtins.anthropic?.thinkingLevel).toBe('low')
    expect(svc.getInjection()).toMatchObject({ thinkingLevel: 'low' })
  })

  it('setBaseUrl normalizes, strips trailing slash and pasted endpoint suffixes', async () => {
    const svc = await createService({
      store: makeStore({ ...empty, builtins: { anthropic: null, openai: { model: 'gpt-4o', apiKey: 'sk-x' } } }),
    })
    await svc.setBaseUrl('openai', 'https://api.deepseek.com/')
    expect(svc.getState().builtins.openai?.baseUrl).toBe('https://api.deepseek.com')
    await svc.setBaseUrl('openai', 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(svc.getState().builtins.openai?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    await svc.setBaseUrl('openai', '')
    expect(svc.getState().builtins.openai?.baseUrl).toBeUndefined()
    expect(await svc.setBaseUrl('openai', 'ftp://x.com')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('addCustomModel / removeCustomModel manage the list on any provider', async () => {
    const svc = await createService({ store: makeStore({ ...empty, custom: [customRow] }) })
    expect((await svc.addCustomModel('c1', 'glm-4-flash')).ok).toBe(true)
    expect(svc.getState().custom[0].customModels).toEqual(['glm-4-flash'])
    expect((await svc.addCustomModel('c1', 'glm-4-flash')).ok).toBe(true) // idempotent
    expect(svc.getState().custom[0].customModels).toEqual(['glm-4-flash'])
    await svc.removeCustomModel('c1', 'glm-4-flash')
    expect(svc.getState().custom[0].customModels).toBeUndefined()
  })

  it('addCustomProvider creates an entry with a generated id and split model list', async () => {
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
    const c = svc.getState().custom.find((x) => x.id === r.id)
    expect(c?.name).toBe('BigModel')
    expect(c?.model).toBe('glm-4')
    expect(c?.customModels).toEqual(['glm-4-flash'])
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

  it('removeCustomProvider deletes the entry and demotes active', async () => {
    const svc = await createService({ store: makeStore({ ...empty, active: 'c1', custom: [customRow] }) })
    expect((await svc.removeCustomProvider('c1')).ok).toBe(true)
    expect(svc.getState().custom).toHaveLength(0)
    expect(svc.getState().active).toBeNull()
    expect(await svc.removeCustomProvider('c1')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('renameCustomProvider updates the name', async () => {
    const svc = await createService({ store: makeStore({ ...empty, custom: [customRow] }) })
    expect((await svc.renameCustomProvider('c1', 'Zhipu')).ok).toBe(true)
    expect(svc.getState().custom[0].name).toBe('Zhipu')
    expect(await svc.renameCustomProvider('c1', '')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('setApiStyle + setContextWindow apply to custom providers and reject on builtins', async () => {
    const svc = await createService({ store: makeStore({ ...withBuiltin(), custom: [customRow] }) })
    expect((await svc.setApiStyle('c1', 'anthropic')).ok).toBe(true)
    expect(svc.getState().custom[0].apiStyle).toBe('anthropic')
    expect(await svc.setApiStyle('anthropic', 'openai')).toMatchObject({ ok: false, code: 'invalid' })

    expect((await svc.setContextWindow('c1', 1_000_000)).ok).toBe(true)
    expect(svc.getState().custom[0].contextWindow).toBe(1_000_000)
    expect((await svc.setContextWindow('c1', null)).ok).toBe(true)
    expect(svc.getState().custom[0].contextWindow).toBeUndefined()
    expect(await svc.setContextWindow('anthropic', 200_000)).toMatchObject({ ok: false, code: 'invalid' })
    expect(await svc.setContextWindow('c1', 0)).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('getInjection: builtin omits apiStyle; custom threads apiStyle + baseUrl + contextWindow', async () => {
    const svc = await createService({
      store: makeStore({
        version: 2,
        active: 'anthropic',
        builtins: { anthropic: { model: 'claude-haiku-4-5', apiKey: 'sk-y' }, openai: null },
        custom: [{ ...customRow, contextWindow: 1_000_000 }],
      }),
    })
    expect(svc.getInjection()).toEqual({ id: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-y' })

    await svc.setActive('c1')
    expect(svc.getInjection()).toEqual({
      id: 'c1',
      model: 'glm-4',
      apiKey: 'sk-c',
      baseUrl: 'https://x.com/v4',
      apiStyle: 'openai',
      contextWindow: 1_000_000,
    })
  })

  it('getInjection returns null with no active provider or an unconfigured builtin', async () => {
    const svc = await createService({ store: makeStore(empty) })
    expect(svc.getInjection()).toBeNull()
    await svc.setActive('anthropic')
    expect(svc.getInjection()).toBeNull()
  })

  it('in-memory state does not advance when store.save throws', async () => {
    const store = makeStore(empty)
    store.save = vi.fn(async () => {
      throw new Error('disk full')
    })
    const svc = await createService({ store })
    expect(await svc.setKey('anthropic', 'sk-x')).toEqual({ ok: false, code: 'persist_failed', message: 'disk full' })
    expect(svc.getState().builtins.anthropic).toBeNull()
  })
})
