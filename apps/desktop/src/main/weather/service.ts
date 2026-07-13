// QWeather config + forecast state machine. Single source of truth for the
// encrypted config and the 30-min in-memory forecast cache. Wraps the Store
// with input validation and a config-change broadcast; getForecast resolves
// coordinates (custom location > GPS > IP), checks the cache, then fetches the
// hourly forecast plus supplementary products (warnings/indices/air/minutely) in
// parallel. Every business path is logged per AGENTS.md §5.
import { createLogger } from '@shared/logger'
import type { WeatherConfig, WeatherConfigOnDisk, WeatherConfigView, WeatherForecast } from '@swarm/protocol'

import { geocodeCity, locateByIp, reverseGeocode } from './geo'
import { fetchAir, fetchHourly, fetchIndices, fetchMinutely, fetchNow, fetchWarnings } from './qweather'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'weather-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

// Redact the config to the renderer-visible projection: the private key PEM is
// replaced by a hasPrivateKey boolean so the secret never crosses the IPC
// boundary on read (matches providers/web-search/gmail). The service keeps the
// full config internally for JWT signing; only the read path redacts.
function toView(c: WeatherConfig): WeatherConfigView {
  return {
    host: c.host,
    projectId: c.projectId,
    credentialId: c.credentialId,
    hasPrivateKey: !!c.privateKeyPem,
    location: c.location,
  }
}

export type Service = {
  getConfig(): WeatherConfigView
  setConfig(c: WeatherConfig): Promise<SetResult>
  /** lng/lat null → IP fallback. Throws on not-configured / fetch failure. */
  getForecast(lng: number | null, lat: number | null): Promise<WeatherForecast>
  onConfigChanged(cb: (c: WeatherConfigView) => void): () => void
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
  const listeners = new Set<(c: WeatherConfigView) => void>()

  // Single-slot cache keyed by rounded "lng,lat".
  let cache: { key: string; forecast: WeatherForecast } | null = null

  // GeoAPI result caches. Unlike the forecast cache, these never expire on a
  // time basis: a city's coordinates and a coordinate's city name are stable
  // geographic facts, so the only invalidation is a changed key (different
  // custom location, or different rounded GPS coord) — a miss follows naturally.
  // Not persisted to disk: a restart costs at most one extra GeoAPI round-trip.
  let geoCache: { key: string; lng: number; lat: number; name: string } | null = null
  let revCache: { key: string; name: string } | null = null

  const emit = (): void => {
    for (const cb of listeners) cb(toView(state))
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
    getConfig: () => toView(state),
    async setConfig(c) {
      // Empty PEM means "keep the existing stored key": the renderer only ever
      // sees the redacted view, so an unchanged key round-trips back empty.
      // Merge it in before validating so partial edits (host/ids) don't force
      // the user to re-paste the secret on every save. A first-time save with
      // no stored key still fails validation below.
      const merged: WeatherConfig =
        c.privateKeyPem.trim() === '' && state.privateKeyPem.trim() !== ''
          ? { ...c, privateKeyPem: state.privateKeyPem }
          : c
      const err = validateConfig(merged)
      if (err) return { ok: false, code: 'invalid', message: err }
      return persist({ weather: merged })
    },
    async getForecast(lng, lat) {
      const err = validateConfig(state)
      if (err) {
        log.warn({ msg: 'weather forecast requested but not configured' })
        throw new Error('not configured')
      }

      // Resolve coordinates + label by priority: custom location > GPS > IP.
      let coordLng: number
      let coordLat: number
      let source: 'gps' | 'ip' | 'custom'
      let label: string
      if (state.location.trim() !== '') {
        // Custom city name wins when set: geocode it via QWeather GeoAPI.
        // Reuse a prior result when the location string is unchanged so polling
        // the forecast doesn't re-spend a GeoAPI call every time.
        if (geoCache && geoCache.key === state.location) {
          coordLng = geoCache.lng
          coordLat = geoCache.lat
          source = 'custom'
          label = geoCache.name
          log.warn({ msg: 'weather custom location geocode cache hit', query: state.location })
        } else {
          try {
            const geo = await geocodeCity(state, state.location)
            coordLng = geo.lng
            coordLat = geo.lat
            source = 'custom'
            label = geo.name
            geoCache = { key: state.location, lng: geo.lng, lat: geo.lat, name: geo.name }
            log.info({
              msg: 'weather custom location geocoded',
              query: state.location,
              label,
              lng: coordLng,
              lat: coordLat,
            })
          } catch (e) {
            log.error({
              msg: 'weather custom location geocode failed',
              query: state.location,
              err: e instanceof Error ? e.message : String(e),
            })
            throw e
          }
        }
      } else if (lng != null && lat != null) {
        coordLng = lng
        coordLat = lat
        source = 'gps'
        // The rounded coord is the identity for reverse geocoding: the same
        // rounding as the forecast key means a static GPS reader reuses the
        // last resolved city name instead of hitting GeoAPI on every poll.
        const revKey = `${round(lng)},${round(lat)}`
        if (revCache && revCache.key === revKey) {
          label = revCache.name
          log.warn({ msg: 'weather reverse geocode cache hit', key: revKey })
        } else {
          label = await reverseGeocode(state, lng, lat)
            .then((name) => {
              revCache = { key: revKey, name }
              return name
            })
            .catch((e) => {
              log.warn({
                msg: 'reverse geocode failed; using coords as label',
                err: e instanceof Error ? e.message : String(e),
              })
              return revKey
            })
        }
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
        // Fetch the core hourly forecast plus the four supplementary products in
        // parallel. Only the hourly fetch is required — warnings/indices/air/
        // minutely are non-fatal, so each degrades to []/null on failure and the
        // card still renders. Minutely is China-only and 404s elsewhere.
        const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
        const [core, warnings, indices, air, minutely, now] = await Promise.all([
          fetchHourly({ config: state, lng: coordLng, lat: coordLat, source, locationLabel: label }),
          fetchWarnings(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather warnings fetch failed', err: errMsg(e) })
            return []
          }),
          fetchIndices(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather indices fetch failed', err: errMsg(e) })
            return []
          }),
          fetchAir(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather air fetch failed', err: errMsg(e) })
            return null
          }),
          fetchMinutely(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather minutely fetch failed', err: errMsg(e) })
            return null
          }),
          fetchNow(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather now fetch failed', err: errMsg(e) })
            return null
          }),
        ])
        const forecast = { ...core, warnings, indices, air, minutely, now }
        cache = { key, forecast }
        log.info({
          msg: 'weather fetched',
          durationMs: Date.now() - started,
          hours: forecast.hours.length,
          warnings: warnings.length,
          indices: indices.length,
          air: air !== null,
          minutely: minutely !== null,
          now: now !== null,
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
