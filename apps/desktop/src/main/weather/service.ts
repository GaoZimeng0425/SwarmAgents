// QWeather config + forecast state machine. Single source of truth for the
// encrypted config and the 30-min in-memory forecast cache. Wraps the Store
// with input validation and a config-change broadcast; getForecast resolves
// coordinates (GPS via renderer args, else IP fallback), checks the cache, then
// calls fetchGridHourly. Every business path is logged per AGENTS.md §5.
import { createLogger } from '@shared/logger'
import type { WeatherConfig, WeatherConfigOnDisk, WeatherForecast } from '@swarm/protocol'

import { locateByIp, reverseGeocode } from './geo'
import { fetchGridHourly } from './qweather'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'weather-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  getConfig(): WeatherConfig
  setConfig(c: WeatherConfig): Promise<SetResult>
  /** lng/lat null → IP fallback. Throws on not-configured / fetch failure. */
  getForecast(lng: number | null, lat: number | null): Promise<WeatherForecast>
  onConfigChanged(cb: (c: WeatherConfig) => void): () => void
}

const CACHE_TTL_MS = 30 * 60 * 1000
const round = (n: number): number => Math.round(n * 100) / 100

function validateConfig(c: WeatherConfig): string | null {
  const m = (msg: string): string => msg
  try {
    new URL(c.host)
  } catch {
    return m('host must be a valid URL')
  }
  if (!c.projectId.trim()) return m('Project ID must not be empty')
  if (!c.credentialId.trim()) return m('Credential ID must not be empty')
  if (!c.privateKeyPem.trim()) return m('Private key PEM must not be empty')
  if (!c.privateKeyPem.includes('BEGIN')) return m('Private key PEM looks malformed')
  return null
}

export async function createService(opts: { store: Store }): Promise<Service> {
  const disk = await opts.store.load()
  let state: WeatherConfig = disk.weather
  const listeners = new Set<(c: WeatherConfig) => void>()

  // Single-slot cache keyed by rounded "lng,lat".
  let cache: { key: string; forecast: WeatherForecast } | null = null

  const emit = (): void => {
    for (const cb of listeners) cb(state)
  }

  const persist = async (next: WeatherConfigOnDisk): Promise<SetResult> => {
    try {
      await opts.store.save(next)
    } catch (e) {
      log.error({ msg: 'failed to persist weather config', err: e instanceof Error ? e.message : String(e) })
      return { ok: false, code: 'persist_failed', message: e instanceof Error ? e.message : String(e) }
    }
    state = next.weather
    cache = null // config changed → invalidate
    emit()
    return { ok: true }
  }

  return {
    getConfig: () => state,
    async setConfig(c) {
      const err = validateConfig(c)
      if (err) return { ok: false, code: 'invalid', message: err }
      return persist({ weather: c })
    },
    async getForecast(lng, lat) {
      const err = validateConfig(state)
      if (err) {
        log.warn({ msg: 'weather forecast requested but not configured' })
        throw new Error('not configured')
      }

      // Resolve coordinates + label.
      let coordLng: number
      let coordLat: number
      let source: 'gps' | 'ip'
      let label: string
      if (lng != null && lat != null) {
        coordLng = lng
        coordLat = lat
        source = 'gps'
        label = await reverseGeocode(state, lng, lat).catch((e) => {
          log.warn({ msg: 'reverse geocode failed; using coords as label', err: e instanceof Error ? e.message : String(e) })
          return `${round(lng)},${round(lat)}`
        })
      } else {
        const ip = await locateByIp()
        coordLng = ip.lng
        coordLat = ip.lat
        source = 'ip'
        label = ip.city
      }

      const key = `${round(coordLng)},${round(coordLat)}`
      if (cache && cache.key === key && Date.now() - cache.forecast.fetchedAt < CACHE_TTL_MS) {
        log.warn({ msg: 'weather cache hit', ageMs: Date.now() - cache.forecast.fetchedAt })
        return cache.forecast
      }

      const started = Date.now()
      log.info({ msg: 'weather fetch', lng: coordLng, lat: coordLat, source })
      try {
        const forecast = await fetchGridHourly({
          config: state,
          lng: coordLng,
          lat: coordLat,
          source,
          locationLabel: label,
        })
        cache = { key, forecast }
        log.info({
          msg: 'weather fetched',
          durationMs: Date.now() - started,
          hours: forecast.hours.length,
          cached: false,
        })
        return forecast
      } catch (e) {
        log.error({
          msg: 'weather fetch failed',
          err: e instanceof Error ? e.message : String(e),
          lng: coordLng,
          lat: coordLat,
          source,
        })
        throw e
      }
    },
    onConfigChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
