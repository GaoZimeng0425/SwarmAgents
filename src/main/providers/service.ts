// src/main/providers/service.ts
//
// Providers state machine. Single source of truth for active provider, models,
// and api keys at runtime. Wraps the encrypted Store with input validation,
// model defaulting/preservation, and a state-change broadcast for the IPC layer.
// Failures during persistence do NOT advance the in-memory state.
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  defaultProvidersStateOnDisk,
  type ModelThinkingLevel,
  OPENAI_MODEL_SUGGESTIONS,
  type ProviderId,
  type ProviderInjection,
  type ProvidersStateOnDisk,
  type ProvidersStateView,
} from '@shared/types/provider'

import { toView } from './redact'
import type { Store } from './store'

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  getState(): ProvidersStateOnDisk
  getView(): ProvidersStateView
  getInjection(): ProviderInjection | null
  setKey(p: ProviderId, key: string): Promise<SetResult>
  clearKey(p: ProviderId): Promise<SetResult>
  setActive(p: ProviderId | null): Promise<SetResult>
  setModel(p: ProviderId, model: string): Promise<SetResult>
  /** Pass an empty string or null to clear. */
  setBaseUrl(p: ProviderId, baseUrl: string | null): Promise<SetResult>
  /** Add to the user-saved custom-model list for this provider. Dedup. */
  addCustomModel(p: ProviderId, model: string): Promise<SetResult>
  /** Remove from the user-saved custom-model list. No-op if absent. */
  removeCustomModel(p: ProviderId, model: string): Promise<SetResult>
  /** Set the wire-format style for the `custom` slot. No-op on built-ins. */
  setApiStyle(p: ProviderId, style: ApiStyle): Promise<SetResult>
  /** Set the reasoning depth for a provider's model. */
  setThinkingLevel(p: ProviderId, level: ModelThinkingLevel): Promise<SetResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
}

const MAX_CUSTOM_MODELS = 50

const DEFAULT_API_STYLE: ApiStyle = 'openai'

const DEFAULT_MODEL = {
  anthropic: ANTHROPIC_MODEL_SUGGESTIONS[0],
  openai: OPENAI_MODEL_SUGGESTIONS[0],
  // The custom slot defaults to OpenAI-style + its first suggestion. The user
  // typically overrides both immediately; this is just to satisfy the
  // non-empty-model schema invariant when they first save a key.
  custom: OPENAI_MODEL_SUGGESTIONS[0],
} as const satisfies Record<ProviderId, string>

function validateKey(key: string): SetResult | null {
  if (key.length === 0) return { ok: false, code: 'invalid', message: 'API key must not be empty' }
  if (/[\r\n]/.test(key)) return { ok: false, code: 'invalid', message: 'API key must not contain newlines' }
  if (key.length > 4096) return { ok: false, code: 'invalid', message: 'API key too long (max 4096 chars)' }
  return null
}

function validateModel(_p: ProviderId, model: string): SetResult | null {
  if (model.length === 0) return { ok: false, code: 'invalid', message: 'model must not be empty' }
  if (model.length > 200) return { ok: false, code: 'invalid', message: 'model too long (max 200 chars)' }
  if (/[\r\n]/.test(model)) return { ok: false, code: 'invalid', message: 'model must not contain newlines' }
  return null
}

type NormalizedBaseUrl = { ok: true; value: string | null } | { ok: false; code: 'invalid'; message: string }

// Endpoint suffixes that users often copy from vendor docs but that should NOT
// be part of baseUrl — pi-ai (and our test-connection) append these themselves.
// Order matters: longer matches first so "/v1/chat/completions" wins over
// "/chat/completions".
const ENDPOINT_SUFFIXES = ['/v1/chat/completions', '/v1/messages', '/chat/completions', '/messages'] as const

/** Normalize a user-typed baseUrl. Empty → null. Otherwise require http(s). */
function normalizeBaseUrl(raw: string | null): NormalizedBaseUrl {
  if (raw === null) return { ok: true, value: null }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > 2048) return { ok: false, code: 'invalid', message: 'baseUrl too long (max 2048 chars)' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, code: 'invalid', message: 'baseUrl must be a valid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, code: 'invalid', message: 'baseUrl must use http or https' }
  // Strip a trailing slash so downstream URL composition stays predictable.
  let value = trimmed.replace(/\/+$/, '')
  // Strip any endpoint suffix the user copied along. Without this, callers
  // would double-append (e.g. `…/v4/chat/completions` + `/chat/completions`).
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, -suffix.length)
      break
    }
  }
  return { ok: true, value }
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
      // The custom slot's apiStyle decides the wire format; built-ins are
      // implicit and never need it on the wire.
      const apiStyle = state.active === 'custom' ? (row.apiStyle ?? DEFAULT_API_STYLE) : undefined
      return {
        id: state.active,
        model: row.model,
        apiKey: row.apiKey,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(apiStyle ? { apiStyle } : {}),
        ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
      }
    },
    async setKey(p, key) {
      const v = validateKey(key)
      if (v) return v
      const existing = state.providers[p]
      const model = existing ? existing.model : DEFAULT_MODEL[p]
      const baseUrl = existing?.baseUrl
      const customModels = existing?.customModels
      // Custom slot needs an apiStyle to be meaningful; default it on first
      // save so worker dispatch never sees an unset style.
      const apiStyle = existing?.apiStyle ?? (p === 'custom' ? DEFAULT_API_STYLE : undefined)
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: {
          ...state.providers,
          [p]: {
            model,
            apiKey: key,
            ...(baseUrl ? { baseUrl } : {}),
            ...(customModels && customModels.length > 0 ? { customModels } : {}),
            ...(apiStyle ? { apiStyle } : {}),
          },
        },
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
      const row = state.providers[p]
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: `no key configured for ${p}; set a key first`,
        }
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: { ...row, model } },
      }
      return persist(next)
    },
    async addCustomModel(p, model) {
      const v = validateModel(p, model)
      if (v) return v
      const row = state.providers[p]
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: `no key configured for ${p}; set a key first`,
        }
      const trimmed = model.trim()
      const existing = row.customModels ?? []
      if (existing.includes(trimmed)) return { ok: true } // idempotent
      if (existing.length >= MAX_CUSTOM_MODELS)
        return {
          ok: false,
          code: 'invalid',
          message: `custom-model list full (max ${MAX_CUSTOM_MODELS})`,
        }
      const nextList = [...existing, trimmed]
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: { ...row, customModels: nextList } },
      }
      return persist(next)
    },
    async removeCustomModel(p, model) {
      const row = state.providers[p]
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: `no key configured for ${p}; set a key first`,
        }
      const existing = row.customModels ?? []
      if (!existing.includes(model)) return { ok: true } // idempotent
      const nextList = existing.filter((m) => m !== model)
      let nextRow: ProvidersStateOnDisk['providers']['anthropic']
      if (nextList.length === 0) {
        const { customModels: _omit, ...rest } = row
        nextRow = rest
      } else {
        nextRow = { ...row, customModels: nextList }
      }
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: nextRow },
      }
      return persist(next)
    },
    async setApiStyle(p, style) {
      if (p !== 'custom')
        return {
          ok: false,
          code: 'invalid',
          message: 'apiStyle only applies to the custom slot',
        }
      const parsed = style === 'anthropic' || style === 'openai' ? style : null
      if (!parsed) return { ok: false, code: 'invalid', message: `unknown apiStyle: ${style}` }
      const row = state.providers[p]
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: `no key configured for ${p}; set a key first`,
        }
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: { ...row, apiStyle: parsed } },
      }
      return persist(next)
    },
    async setThinkingLevel(p, level) {
      const row = state.providers[p]
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: `no key configured for ${p}; set a key first`,
        }
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: { ...row, thinkingLevel: level } },
      }
      return persist(next)
    },
    async setBaseUrl(p, baseUrl) {
      const n = normalizeBaseUrl(baseUrl)
      if (!n.ok) return n
      const row = state.providers[p]
      if (!row)
        return {
          ok: false,
          code: 'invalid',
          message: `no key configured for ${p}; set a key first`,
        }
      let nextRow: ProvidersStateOnDisk['providers']['anthropic']
      if (n.value) {
        nextRow = { ...row, baseUrl: n.value }
      } else {
        const { baseUrl: _omit, ...rest } = row
        nextRow = rest
      }
      const next: ProvidersStateOnDisk = {
        ...state,
        providers: { ...state.providers, [p]: nextRow },
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
