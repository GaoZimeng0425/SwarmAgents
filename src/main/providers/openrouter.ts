// src/main/providers/openrouter.ts
//
// Fetches the OpenRouter model catalog and exposes per-model context window +
// pricing for the providers UI's "fetch" action. Network lives here; the
// service stays a pure state machine.
import { createLogger } from '@shared/logger'
import type { ModelMeta, ModelPricing } from '@shared/types/provider'

const log = createLogger({ process: 'main' }).child({ component: 'openrouter' })

const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 60 * 60 * 1000 // 1h
const TIMEOUT_MS = 15_000

export type Catalog = Map<string, ModelMeta>

let cache: { at: number; catalog: Catalog } | null = null

// OpenRouter prices are "USD per token" strings; pi-ai cost is "USD per 1M".
function toPerM(perToken: unknown): number | null {
  if (typeof perToken !== 'string') return null
  const n = Number(perToken)
  if (!Number.isFinite(n) || n < 0) return null
  return n * 1_000_000
}

function parsePricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const inputPerM = toPerM(r.prompt)
  const outputPerM = toPerM(r.completion)
  if (inputPerM == null || outputPerM == null) return undefined
  const cacheReadPerM = toPerM(r.input_cache_read)
  const cacheWritePerM = toPerM(r.input_cache_write)
  return {
    inputPerM,
    outputPerM,
    ...(cacheReadPerM != null ? { cacheReadPerM } : {}),
    ...(cacheWritePerM != null ? { cacheWritePerM } : {}),
  }
}

export function parseCatalog(json: unknown): Catalog {
  const out: Catalog = new Map()
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return out
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string') continue
    const meta: ModelMeta = {}
    if (typeof e.context_length === 'number' && Number.isInteger(e.context_length) && e.context_length > 0)
      meta.contextWindow = e.context_length
    const pricing = parsePricing(e.pricing)
    if (pricing) meta.pricing = pricing
    if (meta.contextWindow != null || meta.pricing) out.set(e.id, meta)
  }
  return out
}

// Exact id match first, else match by the segment after the last '/' (custom
// model ids often omit the OpenRouter "vendor/" prefix).
export function lookupModel(catalog: Catalog, modelId: string): ModelMeta | null {
  const exact = catalog.get(modelId)
  if (exact) return exact
  for (const [orId, meta] of catalog) {
    if (orId.slice(orId.lastIndexOf('/') + 1) === modelId) return meta
  }
  return null
}

export async function fetchCatalog(force = false): Promise<Catalog> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.catalog
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  log.info({ msg: 'fetching openrouter catalog' })
  try {
    const res = await fetch(CATALOG_URL, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const catalog = parseCatalog(await res.json())
    cache = { at: Date.now(), catalog }
    log.info({ msg: 'openrouter catalog fetched', count: catalog.size })
    return catalog
  } catch (e) {
    log.error({ msg: 'openrouter catalog fetch failed', err: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    clearTimeout(timer)
  }
}
