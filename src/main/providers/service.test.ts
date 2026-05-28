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
  version: 1,
  active: null,
  providers: { anthropic: null, openai: null, custom: null },
}

describe('service', () => {
  it('init populates state from store', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-1' },
        openai: null,
        custom: null,
      },
    })
    const svc = await createService({ store })
    expect(svc.getState().active).toBe('anthropic')
    expect(svc.getView().providers.anthropic?.hasKey).toBe(true)
  })

  it('setKey persists and broadcasts state', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const calls: unknown[] = []
    svc.onStateChanged((v) => calls.push(v))

    const r = await svc.setKey('anthropic', 'sk-new')
    expect(r).toEqual({ ok: true })
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0].providers.anthropic?.apiKey).toBe('sk-new')
    expect(calls).toHaveLength(1)
  })

  it('setKey rejects empty / oversize / newline keys', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })

    expect(await svc.setKey('anthropic', '')).toEqual({
      ok: false,
      code: 'invalid',
      message: 'API key must not be empty',
    })
    expect(await svc.setKey('anthropic', 'sk-with-\nnewline')).toEqual({
      ok: false,
      code: 'invalid',
      message: 'API key must not contain newlines',
    })
    expect(await svc.setKey('anthropic', 'x'.repeat(5000))).toEqual({
      ok: false,
      code: 'invalid',
      message: 'API key too long (max 4096 chars)',
    })
    expect(store.saved).toHaveLength(0)
  })

  it('setKey preserves model if already set; defaults model otherwise', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: { model: 'claude-opus-4-7', apiKey: 'old' },
        openai: null,
        custom: null,
      },
    })
    const svc = await createService({ store })
    await svc.setKey('anthropic', 'new-key')
    expect(svc.getState().providers.anthropic?.model).toBe('claude-opus-4-7')

    await svc.setKey('openai', 'gpt-key')
    expect(svc.getState().providers.openai?.model).toBe('gpt-4o') // default
  })

  it('clearKey nulls the provider and may demote active', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
        openai: null,
        custom: null,
      },
    })
    const svc = await createService({ store })
    await svc.clearKey('anthropic')
    expect(svc.getState().providers.anthropic).toBeNull()
    expect(svc.getState().active).toBe('anthropic')
  })

  it('setActive accepts null and any ProviderId', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    expect((await svc.setActive('openai')).ok).toBe(true)
    expect(svc.getState().active).toBe('openai')
    expect((await svc.setActive(null)).ok).toBe(true)
    expect(svc.getState().active).toBeNull()
  })

  it('setModel updates only the provider row and accepts any non-empty id', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
        openai: null,
        custom: null,
      },
    })
    const svc = await createService({ store })
    const ok = await svc.setModel('anthropic', 'claude-opus-4-7')
    expect(ok).toEqual({ ok: true })
    expect(svc.getState().providers.anthropic?.model).toBe('claude-opus-4-7')

    // Free-form ids are now valid (third-party providers).
    const custom = await svc.setModel('anthropic', 'claude-3-5-mythos-preview')
    expect(custom).toEqual({ ok: true })
    expect(svc.getState().providers.anthropic?.model).toBe('claude-3-5-mythos-preview')

    const bad = await svc.setModel('anthropic', '')
    expect(bad).toEqual({
      ok: false,
      code: 'invalid',
      message: 'model must not be empty',
    })
  })

  it('setModel on a not-configured provider is invalid', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const r = await svc.setModel('openai', 'gpt-4o')
    expect(r).toEqual({
      ok: false,
      code: 'invalid',
      message: 'no key configured for openai; set a key first',
    })
  })

  it('setBaseUrl persists a valid http(s) URL and strips trailing slash', async () => {
    const store = makeStore({
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    const ok = await svc.setBaseUrl('openai', 'https://api.deepseek.com/')
    expect(ok).toEqual({ ok: true })
    expect(svc.getState().providers.openai?.baseUrl).toBe('https://api.deepseek.com')
    expect(svc.getInjection()).toMatchObject({ baseUrl: 'https://api.deepseek.com' })
  })

  it('setBaseUrl with empty/null clears the override', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    await svc.setBaseUrl('openai', '')
    expect(svc.getState().providers.openai?.baseUrl).toBeUndefined()
    await svc.setBaseUrl('openai', 'https://x.example')
    expect(svc.getState().providers.openai?.baseUrl).toBe('https://x.example')
    await svc.setBaseUrl('openai', null)
    expect(svc.getState().providers.openai?.baseUrl).toBeUndefined()
  })

  it('setBaseUrl strips a trailing /chat/completions or /messages users paste from docs', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    await svc.setBaseUrl('openai', 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect(svc.getState().providers.openai?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    await svc.setBaseUrl('openai', 'https://my.proxy.example/v1/chat/completions')
    expect(svc.getState().providers.openai?.baseUrl).toBe('https://my.proxy.example')
    await svc.setBaseUrl('openai', 'https://anth.example/v1/messages')
    expect(svc.getState().providers.openai?.baseUrl).toBe('https://anth.example')
  })

  it('setBaseUrl rejects non-URL strings and non-http(s) schemes', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    expect(await svc.setBaseUrl('openai', 'not a url')).toMatchObject({
      ok: false,
      code: 'invalid',
    })
    expect(await svc.setBaseUrl('openai', 'ftp://example.com')).toMatchObject({
      ok: false,
      code: 'invalid',
      message: 'baseUrl must use http or https',
    })
  })

  it('setBaseUrl on a not-configured provider is invalid', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const r = await svc.setBaseUrl('openai', 'https://api.deepseek.com')
    expect(r).toEqual({
      ok: false,
      code: 'invalid',
      message: 'no key configured for openai; set a key first',
    })
  })

  it('addCustomModel appends, dedupes, and is idempotent', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    expect((await svc.addCustomModel('openai', 'deepseek-chat')).ok).toBe(true)
    expect(svc.getState().providers.openai?.customModels).toEqual(['deepseek-chat'])
    expect((await svc.addCustomModel('openai', 'deepseek-coder')).ok).toBe(true)
    expect(svc.getState().providers.openai?.customModels).toEqual(['deepseek-chat', 'deepseek-coder'])
    // Idempotent — re-adding doesn't duplicate or fail.
    expect((await svc.addCustomModel('openai', 'deepseek-chat')).ok).toBe(true)
    expect(svc.getState().providers.openai?.customModels).toEqual(['deepseek-chat', 'deepseek-coder'])
  })

  it('addCustomModel rejects empty / oversize ids and caps at 50', async () => {
    const list = Array.from({ length: 50 }, (_, i) => `m${i}`)
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x', customModels: list },
        custom: null,
      },
    })
    const svc = await createService({ store })
    expect(await svc.addCustomModel('openai', '')).toMatchObject({
      ok: false,
      code: 'invalid',
    })
    expect(await svc.addCustomModel('openai', 'one-more')).toMatchObject({
      ok: false,
      code: 'invalid',
      message: 'custom-model list full (max 50)',
    })
  })

  it('removeCustomModel drops the entry and clears the field when emptied', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: {
          model: 'gpt-4o',
          apiKey: 'sk-x',
          customModels: ['deepseek-chat', 'deepseek-coder'],
        },
        custom: null,
      },
    })
    const svc = await createService({ store })
    await svc.removeCustomModel('openai', 'deepseek-chat')
    expect(svc.getState().providers.openai?.customModels).toEqual(['deepseek-coder'])
    await svc.removeCustomModel('openai', 'deepseek-coder')
    expect(svc.getState().providers.openai?.customModels).toBeUndefined()
  })

  it('removeCustomModel is idempotent when the entry is absent', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: { model: 'gpt-4o', apiKey: 'sk-x' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    const r = await svc.removeCustomModel('openai', 'nope')
    expect(r).toEqual({ ok: true })
  })

  it('addCustomModel on a not-configured provider is invalid', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const r = await svc.addCustomModel('openai', 'deepseek-chat')
    expect(r).toEqual({
      ok: false,
      code: 'invalid',
      message: 'no key configured for openai; set a key first',
    })
  })

  it('setKey preserves an existing baseUrl + customModels when rewriting the API key', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: null,
        openai: {
          model: 'gpt-4o',
          apiKey: 'old',
          baseUrl: 'https://api.deepseek.com',
          customModels: ['deepseek-chat'],
        },
        custom: null,
      },
    })
    const svc = await createService({ store })
    await svc.setKey('openai', 'new-key')
    expect(svc.getState().providers.openai?.baseUrl).toBe('https://api.deepseek.com')
    expect(svc.getState().providers.openai?.customModels).toEqual(['deepseek-chat'])
    expect(svc.getState().providers.openai?.apiKey).toBe('new-key')
  })

  it('in-memory state does not advance when store.save throws', async () => {
    const store = makeStore(empty)
    store.save = vi.fn(async () => {
      throw new Error('disk full')
    })
    const svc = await createService({ store })
    const r = await svc.setKey('anthropic', 'sk-x')
    expect(r).toEqual({ ok: false, code: 'persist_failed', message: 'disk full' })
    expect(svc.getState().providers.anthropic).toBeNull()
  })

  it('getInjection returns { id, model, apiKey } for the active provider', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-haiku-4-5', apiKey: 'sk-y' },
        openai: null,
        custom: null,
      },
    })
    const svc = await createService({ store })
    const inj = svc.getInjection()
    expect(inj).toEqual({
      id: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-y',
    })
  })

  it('setKey on the custom slot seeds apiStyle to openai when none is set', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    const r = await svc.setKey('custom', 'sk-x')
    expect(r.ok).toBe(true)
    expect(svc.getState().providers.custom?.apiStyle).toBe('openai')
  })

  it('setApiStyle persists on the custom slot and rejects on built-ins', async () => {
    const store = makeStore({
      version: 1,
      active: 'custom',
      providers: {
        anthropic: null,
        openai: null,
        custom: { model: 'gpt-4o', apiKey: 'sk-x', apiStyle: 'openai' },
      },
    })
    const svc = await createService({ store })
    expect((await svc.setApiStyle('custom', 'anthropic')).ok).toBe(true)
    expect(svc.getState().providers.custom?.apiStyle).toBe('anthropic')
    expect(await svc.setApiStyle('anthropic', 'openai')).toMatchObject({
      ok: false,
      code: 'invalid',
    })
  })

  it('getInjection threads apiStyle for the custom slot', async () => {
    const store = makeStore({
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
    const svc = await createService({ store })
    expect(svc.getInjection()).toEqual({
      id: 'custom',
      model: 'deepseek-chat',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      apiStyle: 'openai',
    })
  })

  it('getInjection does NOT thread apiStyle for built-in slots', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-haiku-4-5', apiKey: 'sk-y' },
        openai: null,
        custom: null,
      },
    })
    const svc = await createService({ store })
    expect(svc.getInjection()).not.toHaveProperty('apiStyle')
  })

  it('getInjection threads baseUrl through when configured', async () => {
    const store = makeStore({
      version: 1,
      active: 'openai',
      providers: {
        anthropic: null,
        openai: { model: 'deepseek-chat', apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com' },
        custom: null,
      },
    })
    const svc = await createService({ store })
    expect(svc.getInjection()).toEqual({
      id: 'openai',
      model: 'deepseek-chat',
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
    })
  })

  it('getInjection returns null when no active or active has no key', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    expect(svc.getInjection()).toBeNull()

    await svc.setActive('anthropic')
    expect(svc.getInjection()).toBeNull()
  })
})
