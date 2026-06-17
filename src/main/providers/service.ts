// src/main/providers/service.ts
//
// Providers state machine (v2). Single source of truth for the active provider,
// the two built-in slots (anthropic/openai) and an arbitrary list of custom
// providers. Wraps the encrypted Store with input validation and a state-change
// broadcast for the IPC layer. Failures during persistence do NOT advance the
// in-memory state.
import { randomUUID } from 'node:crypto'
import { createLogger } from '@shared/logger'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  type BuiltinProviderId,
  type CustomProviderOnDisk,
  defaultProvidersStateOnDisk,
  type ModelThinkingLevel,
  OPENAI_MODEL_SUGGESTIONS,
  type ProviderInjection,
  type ProviderRowOnDisk,
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
  /** Built-in slot: set/replace its key (creates the slot). */
  setKey(id: string, key: string): Promise<SetResult>
  /** Built-in slot only: remove it. Custom providers use removeCustomProvider. */
  clearKey(id: string): Promise<SetResult>
  setModel(id: string, model: string): Promise<SetResult>
  /** Pass an empty string or null to clear. */
  setBaseUrl(id: string, baseUrl: string | null): Promise<SetResult>
  addCustomModel(id: string, model: string): Promise<SetResult>
  removeCustomModel(id: string, model: string): Promise<SetResult>
  /** Custom providers only. */
  setApiStyle(id: string, style: ApiStyle): Promise<SetResult>
  setThinkingLevel(id: string, level: ModelThinkingLevel): Promise<SetResult>
  /** Custom providers only. Pass null to reset to the default window. */
  setContextWindow(id: string, contextWindow: number | null): Promise<SetResult>
  // Custom-provider lifecycle.
  addCustomProvider(input: AddCustomInput): Promise<AddResult>
  removeCustomProvider(id: string): Promise<SetResult>
  renameCustomProvider(id: string, name: string): Promise<SetResult>
  onStateChanged(cb: (v: ProvidersStateView) => void): () => void
}

const MAX_CUSTOM_MODELS = 50

const DEFAULT_MODEL: Record<BuiltinProviderId, string> = {
  anthropic: ANTHROPIC_MODEL_SUGGESTIONS[0],
  openai: OPENAI_MODEL_SUGGESTIONS[0],
}

const invalid = (message: string): SetResult => ({ ok: false, code: 'invalid', message })

function isBuiltin(id: string): id is BuiltinProviderId {
  return id === 'anthropic' || id === 'openai'
}

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

  // Read the row for any id (builtin slot or custom entry).
  const readRow = (id: string): ProviderRowOnDisk | null => {
    if (id === 'anthropic') return state.builtins.anthropic
    if (id === 'openai') return state.builtins.openai
    return state.custom.find((c) => c.id === id) ?? null
  }

  // Replace the row for an id with `nextRow`. nextRow is the complete intended
  // row (the patch deletes fields it wants gone), so we must NOT merge it over
  // the original — that would resurrect deleted optional fields (e.g. a cleared
  // contextWindow). We only carry over the custom identity (id/name/apiStyle).
  const withRow = (id: string, nextRow: ProviderRowOnDisk): ProvidersStateOnDisk => {
    if (isBuiltin(id)) {
      return { ...state, builtins: { ...state.builtins, [id]: nextRow } }
    }
    return {
      ...state,
      custom: state.custom.map((c) =>
        c.id === id
          ? ({ ...nextRow, id: c.id, name: c.name, apiStyle: nextRow.apiStyle ?? c.apiStyle } as CustomProviderOnDisk)
          : c
      ),
    }
  }

  // Mutate an existing row by id; errors if absent.
  const patchRow = (id: string, patch: (row: ProviderRowOnDisk) => ProviderRowOnDisk): Promise<SetResult> => {
    const row = readRow(id)
    if (!row) return Promise.resolve(invalid(`no provider configured for "${id}"`))
    return persist(withRow(id, patch(row)))
  }

  return {
    getState: () => state,
    getView: () => toView(state),
    getInjection: () => {
      if (!state.active) return null
      const row = readRow(state.active)
      if (!row) return null
      const apiStyle = isBuiltin(state.active) ? undefined : row.apiStyle
      const contextWindow = isBuiltin(state.active) ? undefined : row.contextWindow
      return {
        id: state.active,
        model: row.model,
        apiKey: row.apiKey,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(apiStyle ? { apiStyle } : {}),
        ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }
    },

    async setActive(id) {
      if (id !== null && !isBuiltin(id) && !state.custom.some((c) => c.id === id))
        return invalid(`unknown provider "${id}"`)
      return persist({ ...state, active: id })
    },

    async setKey(id, key) {
      const v = validateKey(key)
      if (v) return invalid(v)
      if (isBuiltin(id)) {
        const existing = state.builtins[id]
        const nextRow: ProviderRowOnDisk = existing
          ? { ...existing, apiKey: key }
          : { model: DEFAULT_MODEL[id], apiKey: key }
        return persist({ ...state, builtins: { ...state.builtins, [id]: nextRow } })
      }
      return patchRow(id, (row) => ({ ...row, apiKey: key }))
    },

    async clearKey(id) {
      if (!isBuiltin(id)) return invalid('use removeCustomProvider to remove a custom provider')
      return persist({ ...state, builtins: { ...state.builtins, [id]: null } })
    },

    async setModel(id, model) {
      const v = validateModel(model)
      if (v) return invalid(v)
      return patchRow(id, (row) => ({ ...row, model }))
    },

    async setBaseUrl(id, baseUrl) {
      const n = normalizeBaseUrl(baseUrl)
      if (!n.ok) return invalid(n.message)
      return patchRow(id, (row) => {
        if (n.value) return { ...row, baseUrl: n.value }
        const { baseUrl: _omit, ...rest } = row
        return rest
      })
    },

    async addCustomModel(id, model) {
      const v = validateModel(model)
      if (v) return invalid(v)
      const trimmed = model.trim()
      return patchRow(id, (row) => {
        const existing = row.customModels ?? []
        if (existing.includes(trimmed)) return row
        if (existing.length >= MAX_CUSTOM_MODELS) throw new Error(`custom-model list full (max ${MAX_CUSTOM_MODELS})`)
        return { ...row, customModels: [...existing, trimmed] }
      }).catch((e) => invalid(e instanceof Error ? e.message : String(e)))
    },

    async removeCustomModel(id, model) {
      return patchRow(id, (row) => {
        const existing = row.customModels ?? []
        if (!existing.includes(model)) return row
        const nextList = existing.filter((m) => m !== model)
        if (nextList.length === 0) {
          const { customModels: _omit, ...rest } = row
          return rest
        }
        return { ...row, customModels: nextList }
      })
    },

    async setApiStyle(id, style) {
      if (isBuiltin(id)) return invalid('apiStyle only applies to custom providers')
      if (style !== 'anthropic' && style !== 'openai') return invalid(`unknown apiStyle: ${style}`)
      return patchRow(id, (row) => ({ ...row, apiStyle: style }))
    },

    async setThinkingLevel(id, level) {
      return patchRow(id, (row) => ({ ...row, thinkingLevel: level }))
    },

    async setContextWindow(id, contextWindow) {
      if (isBuiltin(id)) return invalid('contextWindow only applies to custom providers')
      if (
        contextWindow !== null &&
        (!Number.isInteger(contextWindow) || contextWindow <= 0 || contextWindow > 10_000_000)
      )
        return invalid('contextWindow must be a positive integer ≤ 10,000,000')
      return patchRow(id, (row) => {
        if (contextWindow == null) {
          const { contextWindow: _omit, ...rest } = row
          return rest
        }
        return { ...row, contextWindow }
      })
    },

    async addCustomProvider(input) {
      const nameErr = validateName(input.name)
      if (nameErr) return { ok: false, code: 'invalid', message: nameErr }
      const keyErr = validateKey(input.apiKey)
      if (keyErr) return { ok: false, code: 'invalid', message: keyErr }
      if (input.apiStyle !== 'anthropic' && input.apiStyle !== 'openai')
        return { ok: false, code: 'invalid', message: `unknown apiStyle: ${input.apiStyle}` }
      const models = input.models.map((m) => m.trim()).filter((m) => m.length > 0)
      if (models.length === 0) return { ok: false, code: 'invalid', message: 'add at least one model' }
      for (const m of models) {
        const me = validateModel(m)
        if (me) return { ok: false, code: 'invalid', message: me }
      }
      const n = normalizeBaseUrl(input.baseUrl ?? null)
      if (!n.ok) return { ok: false, code: 'invalid', message: n.message }

      const id = randomUUID()
      const provider: CustomProviderOnDisk = {
        id,
        name: input.name.trim(),
        model: models[0],
        apiKey: input.apiKey,
        apiStyle: input.apiStyle,
        ...(n.value ? { baseUrl: n.value } : {}),
        ...(models.length > 1 ? { customModels: models.slice(1) } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      }
      const r = await persist({ ...state, custom: [...state.custom, provider] })
      return r.ok ? { ok: true, id } : r
    },

    async removeCustomProvider(id) {
      if (!state.custom.some((c) => c.id === id)) return invalid(`unknown custom provider "${id}"`)
      const nextActive = state.active === id ? null : state.active
      return persist({ ...state, active: nextActive, custom: state.custom.filter((c) => c.id !== id) })
    },

    async renameCustomProvider(id, name) {
      const nameErr = validateName(name)
      if (nameErr) return invalid(nameErr)
      if (!state.custom.some((c) => c.id === id)) return invalid(`unknown custom provider "${id}"`)
      return persist({ ...state, custom: state.custom.map((c) => (c.id === id ? { ...c, name: name.trim() } : c)) })
    },

    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

export { defaultProvidersStateOnDisk }
