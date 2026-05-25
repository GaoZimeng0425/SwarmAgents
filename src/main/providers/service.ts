// src/main/providers/service.ts
//
// Providers state machine. Single source of truth for active provider, models,
// and api keys at runtime. Wraps the encrypted Store with input validation,
// model defaulting/preservation, and a state-change broadcast for the IPC layer.
// Failures during persistence do NOT advance the in-memory state.
import {
  AnthropicModel,
  defaultProvidersStateOnDisk,
  OpenAIModel,
  type ProviderId,
  type ProviderInjection,
  type ProvidersStateOnDisk,
  type ProvidersStateView,
} from '@shared/types/provider'

import { toView } from './redact'
import type { Store } from './store'

export type SetResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  getState(): ProvidersStateOnDisk
  getView(): ProvidersStateView
  getInjection(): ProviderInjection | null
  setKey(p: ProviderId, key: string): Promise<SetResult>
  clearKey(p: ProviderId): Promise<SetResult>
  setActive(p: ProviderId | null): Promise<SetResult>
  setModel(p: ProviderId, model: string): Promise<SetResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
}

const DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
} as const satisfies Record<ProviderId, string>

function validateKey(key: string): SetResult | null {
  if (key.length === 0) return { ok: false, code: 'invalid', message: 'API key must not be empty' }
  if (/[\r\n]/.test(key))
    return { ok: false, code: 'invalid', message: 'API key must not contain newlines' }
  if (key.length > 4096)
    return { ok: false, code: 'invalid', message: 'API key too long (max 4096 chars)' }
  return null
}

function validateModel(p: ProviderId, model: string): SetResult | null {
  const enumForProvider = p === 'anthropic' ? AnthropicModel : OpenAIModel
  const parsed = enumForProvider.safeParse(model)
  if (!parsed.success)
    return { ok: false, code: 'invalid', message: `unknown model id for ${p}: ${model}` }
  return null
}

export async function createService(opts: { store: Store }): Promise<Service> {
  let state = await opts.store.load()
  const listeners = new Set<(v: ProvidersStateView) => void>()

  const emit = (): void => {
    const v = toView(state)
    for (const cb of listeners) cb(v)
  }

  const persist = async (next: ProvidersStateOnDisk): Promise<SetResult> => {
    try {
      await opts.store.save(next)
    } catch (e) {
      return {
        ok: false,
        code: 'persist_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
    state = next
    emit()
    return { ok: true }
  }

  return {
    getState: () => state,
    getView: () => toView(state),
    getInjection: () => {
      if (!state.active) return null
      const row = state.providers[state.active]
      if (!row) return null
      return { id: state.active, model: row.model, apiKey: row.apiKey }
    },
    async setKey(p, key) {
      const v = validateKey(key)
      if (v) return v
      // Branch on p so TS can narrow the model literal type for each provider.
      let next: ProvidersStateOnDisk
      if (p === 'anthropic') {
        const existing = state.providers.anthropic
        const model = existing ? existing.model : DEFAULT_MODEL.anthropic
        next = {
          ...state,
          providers: { ...state.providers, anthropic: { model, apiKey: key } },
        }
      } else {
        const existing = state.providers.openai
        const model = existing ? existing.model : DEFAULT_MODEL.openai
        next = {
          ...state,
          providers: { ...state.providers, openai: { model, apiKey: key } },
        }
      }
      return persist(next)
    },
    async clearKey(p) {
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: null },
      }
      return persist(next)
    },
    async setActive(p) {
      const next: ProvidersStateOnDisk = { ...state, active: p }
      return persist(next)
    },
    async setModel(p, model) {
      const v = validateModel(p, model)
      if (v) return v
      // Branch so TS narrows the row + model literal types per provider.
      if (p === 'anthropic') {
        const row = state.providers.anthropic
        if (!row)
          return {
            ok: false,
            code: 'invalid',
            message: 'no key configured for anthropic; set a key first',
          }
        const next: ProvidersStateOnDisk = {
          ...state,
          providers: {
            ...state.providers,
            anthropic: { ...row, model: AnthropicModel.parse(model) },
          },
        }
        return persist(next)
      }
      const row = state.providers.openai
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: 'no key configured for openai; set a key first',
        }
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: {
          ...state.providers,
          openai: { ...row, model: OpenAIModel.parse(model) },
        },
      }
      return persist(next)
    },
    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

// Re-exports used by callers that just want a fresh empty state.
export { defaultProvidersStateOnDisk }
