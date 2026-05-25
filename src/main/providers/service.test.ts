import { describe, expect, it, vi } from 'vitest'

import type { ProvidersStateOnDisk } from '@shared/types/provider'

import type { Store } from './store'
import { createService } from './service'

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
  providers: { anthropic: null, openai: null },
}

describe('service', () => {
  it('init populates state from store', async () => {
    const store = makeStore({
      version: 1,
      active: 'anthropic',
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-1' },
        openai: null,
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

  it('setModel updates only the provider row and validates enum', async () => {
    const store = makeStore({
      version: 1,
      active: null,
      providers: {
        anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
        openai: null,
      },
    })
    const svc = await createService({ store })
    const ok = await svc.setModel('anthropic', 'claude-opus-4-7')
    expect(ok).toEqual({ ok: true })
    expect(svc.getState().providers.anthropic?.model).toBe('claude-opus-4-7')

    const bad = await svc.setModel('anthropic', 'gpt-4o')
    expect(bad).toEqual({
      ok: false,
      code: 'invalid',
      message: 'unknown model id for anthropic: gpt-4o',
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

  it('getInjection returns null when no active or active has no key', async () => {
    const store = makeStore(empty)
    const svc = await createService({ store })
    expect(svc.getInjection()).toBeNull()

    await svc.setActive('anthropic')
    expect(svc.getInjection()).toBeNull()
  })
})
