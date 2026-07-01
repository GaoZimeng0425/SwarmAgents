// src/main/providers/openrouter.ts
//
// Fetches the OpenRouter model catalog and exposes per-model context window +
// pricing for the providers UI's "fetch" action and for auto-matching pricing
// when a model is added. The catalog is cached in memory (1h TTL) and persisted
// to a local JSON file so matching survives restarts and works offline. Network
// lives here; the service stays a pure state machine.
import { promises as fs } from 'node:fs'
import { createLogger } from '@shared/logger'
import type { ModelMeta, ModelPricing } from '@swarm/protocol'

const log = createLogger({ process: 'main' }).child({ component: 'openrouter' })

const CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 60 * 60 * 1000 // 1h
const TIMEOUT_MS = 15_000

export type Catalog = Map<string, ModelMeta>

let cache: { at: number; catalog: Catalog } | null = null

// On-disk shape: a flat record keyed by OpenRouter id plus the fetch timestamp,
// so a reload can re-apply the same TTL the in-memory cache uses.
type DiskCatalog = { at: number; models: Record<string, ModelMeta> }

/** Read the persisted catalog, or null if absent/unreadable/malformed. */
export async function readDiskCatalog(catalogPath: string): Promise<{ at: number; catalog: Catalog } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as DiskCatalog
    if (!parsed || typeof parsed.at !== 'number' || !parsed.models || typeof parsed.models !== 'object') return null
    return { at: parsed.at, catalog: new Map(Object.entries(parsed.models)) }
  } catch {
    return null
  }
}

/** Persist the catalog as plain JSON (atomic write via tmp + rename). */
export async function writeDiskCatalog(catalogPath: string, at: number, catalog: Catalog): Promise<void> {
  const payload: DiskCatalog = { at, models: Object.fromEntries(catalog) }
  const tmp = `${catalogPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload))
  await fs.rename(tmp, catalogPath)
}

/** Test-only: clear the in-memory cache so each test starts cold. */
export function __resetCatalogCacheForTest(): void {
  cache = null
}

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
  const data = json != null && typeof json === 'object' ? (json as { data?: unknown }).data : undefined
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
// model ids often omit the OpenRouter "vendor/" prefix). Matching is
// case-insensitive: configured ids and OpenRouter ids may differ in case.
export function lookupModel(catalog: Catalog, modelId: string): ModelMeta | null {
  const needle = modelId.toLowerCase()
  for (const [orId, meta] of catalog) {
    if (orId.toLowerCase() === needle) return meta
  }
  for (const [orId, meta] of catalog) {
    const lc = orId.toLowerCase()
    if (lc.slice(lc.lastIndexOf('/') + 1) === needle) return meta
  }
  return null
}

// Return the best available catalog. Order: fresh in-memory cache → (unless
// forced) fresh on-disk copy (seeds memory, no network) → network fetch (writes
// disk + memory). On network failure, fall back to any on-disk copy even if
// stale, so adding a model still auto-matches offline. `catalogPath` enables the
// disk layer; omit it (tests) to use memory/network only.
export async function fetchCatalog(opts: { force?: boolean; catalogPath?: string } = {}): Promise<Catalog> {
  const { force = false, catalogPath } = opts
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.catalog

  if (!force && !cache && catalogPath) {
    const disk = await readDiskCatalog(catalogPath)
    if (disk && Date.now() - disk.at < TTL_MS) {
      cache = disk
      log.info({ msg: 'openrouter catalog loaded from disk', count: disk.catalog.size })
      return disk.catalog
    }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  log.info({ msg: 'fetching openrouter catalog' })
  try {
    const res = await fetch(CATALOG_URL, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const catalog = parseCatalog(await res.json())
    const at = Date.now()
    cache = { at, catalog }
    if (catalogPath) {
      await writeDiskCatalog(catalogPath, at, catalog).catch((e) =>
        log.warn({ msg: 'openrouter catalog persist failed', err: e instanceof Error ? e.message : String(e) })
      )
    }
    log.info({ msg: 'openrouter catalog fetched', count: catalog.size })
    return catalog
  } catch (e) {
    if (catalogPath) {
      const disk = await readDiskCatalog(catalogPath)
      if (disk) {
        cache = disk
        log.warn({
          msg: 'openrouter catalog network failed; using stale disk copy',
          err: e instanceof Error ? e.message : String(e),
          count: disk.catalog.size,
        })
        return disk.catalog
      }
    }
    log.error({ msg: 'openrouter catalog fetch failed', err: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    clearTimeout(timer)
  }
}
