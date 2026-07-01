// src/main/web-search/service.ts
//
// Web-search config state machine. Single source of truth for the chosen
// provider, per-backend API keys, and the SearXNG URL. Wraps the encrypted
// Store with input validation and a state-change broadcast for the IPC layer.
// Failures during persistence do NOT advance the in-memory state.
import { createLogger } from '@shared/logger'
import type {
  WebSearchConfigOnDisk,
  WebSearchConfigView,
  WebSearchInjection,
  WebSearchProviderId,
} from '@swarm/protocol'

import { toView } from './redact'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'web-search-service' })

export type KeyId = 'tavily' | 'brave'
export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  getState(): WebSearchConfigOnDisk
  getView(): WebSearchConfigView
  getInjection(): WebSearchInjection
  setProvider(p: WebSearchProviderId): Promise<SetResult>
  setKey(id: KeyId, key: string): Promise<SetResult>
  clearKey(id: KeyId): Promise<SetResult>
  /** Pass an empty string or null to clear. */
  setSearxngUrl(url: string | null): Promise<SetResult>
  onStateChanged(cb: (v: WebSearchConfigView) => void): () => void
}

function validateKey(key: string): SetResult | null {
  if (key.length === 0) return { ok: false, code: 'invalid', message: 'API key must not be empty' }
  if (/[\r\n]/.test(key)) return { ok: false, code: 'invalid', message: 'API key must not contain newlines' }
  if (key.length > 4096) return { ok: false, code: 'invalid', message: 'API key too long (max 4096 chars)' }
  return null
}

type NormalizedUrl = { ok: true; value: string | null } | { ok: false; code: 'invalid'; message: string }

// Empty → null (clear). Otherwise require an http(s) URL and strip a trailing
// slash so the tool's `/search` composition stays predictable.
function normalizeUrl(raw: string | null): NormalizedUrl {
  if (raw === null) return { ok: true, value: null }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > 2048) return { ok: false, code: 'invalid', message: 'URL too long (max 2048 chars)' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, code: 'invalid', message: 'SearXNG URL must be a valid URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return { ok: false, code: 'invalid', message: 'SearXNG URL must use http or https' }
  return { ok: true, value: trimmed.replace(/\/+$/, '') }
}

export async function createService(opts: { store: Store }): Promise<Service> {
  let state = await opts.store.load()
  const listeners = new Set<(v: WebSearchConfigView) => void>()

  const emit = (): void => {
    const v = toView(state)
    for (const cb of listeners) cb(v)
  }

  const persist = async (next: WebSearchConfigOnDisk): Promise<SetResult> => {
    try {
      await opts.store.save(next)
    } catch (e) {
      log.error({ msg: 'failed to persist web-search config', err: e instanceof Error ? e.message : String(e) })
      return { ok: false, code: 'persist_failed', message: e instanceof Error ? e.message : String(e) }
    }
    state = next
    emit()
    return { ok: true }
  }

  return {
    getState: () => state,
    getView: () => toView(state),
    getInjection: () => ({
      provider: state.provider,
      ...(state.keys.tavily ? { tavilyKey: state.keys.tavily } : {}),
      ...(state.keys.brave ? { braveKey: state.keys.brave } : {}),
      ...(state.searxngUrl ? { searxngUrl: state.searxngUrl } : {}),
    }),
    async setProvider(p) {
      return persist({ ...state, provider: p })
    },
    async setKey(id, key) {
      const v = validateKey(key)
      if (v) return v
      return persist({ ...state, keys: { ...state.keys, [id]: key } })
    },
    async clearKey(id) {
      const { [id]: _omit, ...rest } = state.keys
      return persist({ ...state, keys: rest })
    },
    async setSearxngUrl(url) {
      const n = normalizeUrl(url)
      if (!n.ok) return n
      if (n.value) return persist({ ...state, searxngUrl: n.value })
      const { searxngUrl: _omit, ...rest } = state
      return persist(rest)
    },
    onStateChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
