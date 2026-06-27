// src/main/providers/service.ts
//
// Providers state machine (v3). Single source of truth for the active provider
// and one flat list of providers (built-in or custom — distinguished only by
// `registry`). Wraps the encrypted Store with input validation and a
// state-change broadcast for the IPC layer. Failures during persistence do NOT
// advance the in-memory state.
import { randomUUID } from 'node:crypto'
import { createLogger } from '@shared/logger'
import {
  type ApiStyle,
  BUILTIN_DEFS,
  defaultProvidersStateOnDisk,
  isBuiltinId,
  MAX_MODELS,
  type ModelMeta,
  type ModelThinkingLevel,
  type Provider,
  type ProviderInjection,
  type ProvidersStateOnDisk,
  type ProvidersStateView,
} from '@shared/types/provider'

import { toView } from './redact'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'providers-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }
export type AddResult = { ok: true; id: string } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type AddCustomInput = {
  name: string
  apiKey: string
  apiStyle: ApiStyle
  baseUrl?: string | null
  models: string[]
  thinkingLevel?: ModelThinkingLevel
}

export type Service = {
  getState(): ProvidersStateOnDisk
  getView(): ProvidersStateView
  getInjection(): ProviderInjection | null
  setActive(id: string | null): Promise<SetResult>
  /** Built-in: set/replace its key (materializes the provider on first use). */
  setKey(id: string, key: string): Promise<SetResult>
  /** Built-in only: remove the provider. Custom providers use removeCustomProvider. */
  clearKey(id: string): Promise<SetResult>
  setModel(id: string, model: string): Promise<SetResult>
  /** Pass an empty string or null to clear. */
  setBaseUrl(id: string, baseUrl: string | null): Promise<SetResult>
  addCustomModel(id: string, model: string): Promise<SetResult>
  removeCustomModel(id: string, model: string): Promise<SetResult>
  /** Custom providers only (a built-in's apiStyle is fixed to its wire format). */
  setApiStyle(id: string, style: ApiStyle): Promise<SetResult>
  setThinkingLevel(id: string, level: ModelThinkingLevel): Promise<SetResult>
  /**
   * Set the ordered fallback provider ids for a provider (tried when its request
   * fails). Sanitized: de-duplicated, self-reference and unknown ids dropped; an
   * empty result clears the field.
   */
  setFallbackProviderIds(id: string, ids: string[]): Promise<SetResult>
  /** Custom providers only. Set/clear one model's context window. Pass null to clear. */
  setModelContextWindow(id: string, model: string, contextWindow: number | null): Promise<SetResult>
  /** Custom providers only. Merge pulled per-model metadata (OpenRouter). Incoming fields override. */
  mergeModelMeta(id: string, map: Record<string, ModelMeta>): Promise<SetResult>
  // Custom-provider lifecycle.
  addCustomProvider(input: AddCustomInput): Promise<AddResult>
  removeCustomProvider(id: string): Promise<SetResult>
  renameCustomProvider(id: string, name: string): Promise<SetResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
}

const invalid = (message: string): SetResult => ({ ok: false, code: 'invalid', message })

function validateKey(key: string): string | null {
  if (key.length === 0) return 'API key must not be empty'
  if (/[\r\n]/.test(key)) return 'API key must not contain newlines'
  if (key.length > 4096) return 'API key too long (max 4096 chars)'
  return null
}

function validateModel(model: string): string | null {
  if (model.length === 0) return 'model must not be empty'
  if (model.length > 200) return 'model too long (max 200 chars)'
  if (/[\r\n]/.test(model)) return 'model must not contain newlines'
  return null
}

function validateName(name: string): string | null {
  const t = name.trim()
  if (t.length === 0) return 'name must not be empty'
  if (t.length > 100) return 'name too long (max 100 chars)'
  return null
}

type NormalizedBaseUrl = { ok: true; value: string | null } | { ok: false; message: string }

// Endpoint suffixes users often paste from vendor docs but that must NOT be part
// of baseUrl — pi-ai appends these itself. Longest match first.
const ENDPOINT_SUFFIXES = ['/v1/chat/completions', '/v1/messages', '/chat/completions', '/messages'] as const

function normalizeBaseUrl(raw: string | null): NormalizedBaseUrl {
  if (raw === null) return { ok: true, value: null }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > 2048) return { ok: false, message: 'baseUrl too long (max 2048 chars)' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, message: 'baseUrl must be a valid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, message: 'baseUrl must use http or https' }
  let value = trimmed.replace(/\/+$/, '')
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, -suffix.length)
      break
    }
  }
  return { ok: true, value }
}

// Build a fresh built-in provider row from its canonical definition.
function makeBuiltin(id: 'anthropic' | 'openai', apiKey: string): Provider {
  const def = BUILTIN_DEFS[id]
  const model = def.suggestions[0] as string
  return { id, name: def.name, registry: def.registry, apiStyle: def.apiStyle, apiKey, models: [model], model }
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
      log.error({ msg: 'failed to persist providers', err: e instanceof Error ? e.message : String(e) })
      return { ok: false, code: 'persist_failed', message: e instanceof Error ? e.message : String(e) }
    }
    state = next
    emit()
    return { ok: true }
  }

  const find = (id: string): Provider | undefined => state.providers.find((p) => p.id === id)

  const isCustom = (p: Provider): boolean => p.registry === undefined

  // Replace the provider with `id` using `next` (the complete intended row).
  const replaceProvider = (id: string, next: Provider): ProvidersStateOnDisk => ({
    ...state,
    providers: state.providers.map((p) => (p.id === id ? next : p)),
  })

  // Mutate an existing provider by id; errors if absent.
  const patch = (id: string, fn: (p: Provider) => Provider): Promise<SetResult> => {
    const p = find(id)
    if (!p) return Promise.resolve(invalid(`no provider configured for "${id}"`))
    return persist(replaceProvider(id, fn(p)))
  }

  // Set or clear one field of one model's meta, pruning emptied objects so a
  // cleared field never leaves a dangling {} (and an empty modelMeta is dropped).
  const withMetaField = (p: Provider, model: string, contextWindow: number | null): Provider => {
    const meta: Record<string, ModelMeta> = { ...(p.modelMeta ?? {}) }
    const cur: ModelMeta = { ...(meta[model] ?? {}) }
    if (contextWindow == null) delete cur.contextWindow
    else cur.contextWindow = contextWindow
    if (cur.contextWindow == null && cur.pricing == null) delete meta[model]
    else meta[model] = cur
    if (Object.keys(meta).length === 0) {
      const { modelMeta: _omit, ...rest } = p
      return rest
    }
    return { ...p, modelMeta: meta }
  }

  // A single provider → its base injection (no fallback chain). Used for both
  // the active provider and each resolved fallback.
  const toInjection = (p: Provider): ProviderInjection => {
    const meta = p.modelMeta?.[p.model]
    return {
      id: p.id,
      ...(p.registry ? { registry: p.registry } : {}),
      apiStyle: p.apiStyle,
      model: p.model,
      apiKey: p.apiKey,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(p.thinkingLevel ? { thinkingLevel: p.thinkingLevel } : {}),
      ...(meta?.contextWindow != null ? { contextWindow: meta.contextWindow } : {}),
      ...(meta?.pricing ? { pricing: meta.pricing } : {}),
    }
  }

  return {
    getState: () => state,
    getView: () => toView(state),
    getInjection: () => {
      if (!state.active) return null
      const p = find(state.active)
      if (!p) return null
      const base = toInjection(p)
      // Resolve the fallback chain here in Main, where every provider's config
      // (incl. apiKey) lives — the worker's provider registry only holds
      // session-created providers. Drop self-references and unknown ids; fallbacks
      // are flattened one level (their own fallbackProviderIds are ignored).
      const fallbackProviders = (p.fallbackProviderIds ?? [])
        .filter((id) => id !== p.id)
        .map((id) => find(id))
        .filter((fp): fp is Provider => !!fp)
        .map(toInjection)
      return fallbackProviders.length ? { ...base, fallbackProviders } : base
    },

    async setActive(id) {
      if (id !== null && !find(id)) return invalid(`unknown provider "${id}"`)
      return persist({ ...state, active: id })
    },

    async setKey(id, key) {
      const v = validateKey(key)
      if (v) return invalid(v)
      const existing = find(id)
      if (existing) return persist(replaceProvider(id, { ...existing, apiKey: key }))
      if (isBuiltinId(id)) return persist({ ...state, providers: [...state.providers, makeBuiltin(id, key)] })
      return invalid(`unknown provider "${id}" — create custom providers via addCustomProvider`)
    },

    async clearKey(id) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (isCustom(p)) return invalid('use removeCustomProvider to remove a custom provider')
      const active = state.active === id ? null : state.active
      return persist({ ...state, active, providers: state.providers.filter((x) => x.id !== id) })
    },

    async setModel(id, model) {
      const e = validateModel(model)
      if (e) return invalid(e)
      return patch(id, (p) => ({
        ...p,
        model,
        models: p.models.includes(model) ? p.models : [...p.models, model].slice(0, MAX_MODELS),
      }))
    },

    async setBaseUrl(id, baseUrl) {
      const n = normalizeBaseUrl(baseUrl)
      if (!n.ok) return invalid(n.message)
      return patch(id, (p) => {
        if (n.value) return { ...p, baseUrl: n.value }
        const { baseUrl: _omit, ...rest } = p
        return rest
      })
    },

    async addCustomModel(id, model) {
      const e = validateModel(model)
      if (e) return invalid(e)
      const trimmed = model.trim()
      return patch(id, (p) => {
        if (p.models.includes(trimmed)) return p
        if (p.models.length >= MAX_MODELS) throw new Error(`model list full (max ${MAX_MODELS})`)
        return { ...p, models: [...p.models, trimmed] }
      }).catch((e2) => invalid(e2 instanceof Error ? e2.message : String(e2)))
    },

    async removeCustomModel(id, model) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (model === p.model) return invalid('cannot remove the selected model')
      if (!p.models.includes(model)) return { ok: true }
      return persist(replaceProvider(id, { ...p, models: p.models.filter((m) => m !== model) }))
    },

    async setApiStyle(id, style) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (!isCustom(p)) return invalid('apiStyle only applies to custom providers')
      if (style !== 'anthropic' && style !== 'openai') return invalid(`unknown apiStyle: ${style}`)
      return persist(replaceProvider(id, { ...p, apiStyle: style }))
    },

    async setThinkingLevel(id, level) {
      return patch(id, (p) => ({ ...p, thinkingLevel: level }))
    },

    async setFallbackProviderIds(id, ids) {
      const known = new Set(state.providers.map((pr) => pr.id))
      const cleaned = [...new Set(ids)].filter((fid) => fid !== id && known.has(fid))
      return patch(id, (p) => {
        if (cleaned.length === 0) {
          const { fallbackProviderIds: _drop, ...rest } = p
          return rest
        }
        return { ...p, fallbackProviderIds: cleaned }
      })
    },

    async setModelContextWindow(id, model, contextWindow) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (!isCustom(p)) return invalid('contextWindow only applies to custom providers')
      if (!p.models.includes(model)) return invalid(`model "${model}" not in provider "${id}"`)
      if (
        contextWindow !== null &&
        (!Number.isInteger(contextWindow) || contextWindow <= 0 || contextWindow > 10_000_000)
      )
        return invalid('contextWindow must be a positive integer ≤ 10,000,000')
      return persist(replaceProvider(id, withMetaField(p, model, contextWindow)))
    },

    async mergeModelMeta(id, map) {
      const p = find(id)
      if (!p) return invalid(`no provider configured for "${id}"`)
      if (!isCustom(p)) return invalid('modelMeta only applies to custom providers')
      const meta: Record<string, ModelMeta> = { ...(p.modelMeta ?? {}) }
      for (const [model, incoming] of Object.entries(map)) {
        if (!p.models.includes(model)) continue // ignore models not in the list
        meta[model] = { ...(meta[model] ?? {}), ...incoming }
      }
      if (Object.keys(meta).length === 0) {
        const { modelMeta: _omit, ...rest } = p
        return persist(replaceProvider(id, rest))
      }
      return persist(replaceProvider(id, { ...p, modelMeta: meta }))
    },

    async addCustomProvider(input) {
      const nameErr = validateName(input.name)
      if (nameErr) return { ok: false, code: 'invalid', message: nameErr }
      const keyErr = validateKey(input.apiKey)
      if (keyErr) return { ok: false, code: 'invalid', message: keyErr }
      if (input.apiStyle !== 'anthropic' && input.apiStyle !== 'openai')
        return { ok: false, code: 'invalid', message: `unknown apiStyle: ${input.apiStyle}` }
      const models = [...new Set(input.models.map((m) => m.trim()).filter((m) => m.length > 0))].slice(0, MAX_MODELS)
      if (models.length === 0) return { ok: false, code: 'invalid', message: 'add at least one model' }
      for (const m of models) {
        const me = validateModel(m)
        if (me) return { ok: false, code: 'invalid', message: me }
      }
      const n = normalizeBaseUrl(input.baseUrl ?? null)
      if (!n.ok) return { ok: false, code: 'invalid', message: n.message }

      const id = randomUUID()
      const provider: Provider = {
        id,
        name: input.name.trim(),
        apiStyle: input.apiStyle,
        apiKey: input.apiKey,
        models,
        model: models[0] as string,
        ...(n.value ? { baseUrl: n.value } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      }
      const r = await persist({ ...state, providers: [...state.providers, provider] })
      return r.ok ? { ok: true, id } : r
    },

    async removeCustomProvider(id) {
      const p = find(id)
      if (!p) return invalid(`unknown custom provider "${id}"`)
      if (!isCustom(p)) return invalid('cannot remove a built-in provider; use clearKey')
      const active = state.active === id ? null : state.active
      return persist({ ...state, active, providers: state.providers.filter((x) => x.id !== id) })
    },

    async renameCustomProvider(id, name) {
      const nameErr = validateName(name)
      if (nameErr) return invalid(nameErr)
      const p = find(id)
      if (!p) return invalid(`unknown custom provider "${id}"`)
      if (!isCustom(p)) return invalid('cannot rename a built-in provider')
      return persist(replaceProvider(id, { ...p, name: name.trim() }))
    },

    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

export { defaultProvidersStateOnDisk }
