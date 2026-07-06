// Geolocation helpers. locateByIp() is the renderer-failure fallback (main
// process fetch, so HTTP is fine); reverseGeocode() turns GPS coords into a
// Chinese city name via QWeather's own GeoAPI so the card label matches the
// card language. Both throw on failure; the service layer logs + maps the error.
import type { WeatherConfig } from '@swarm/protocol'

import { signQWeatherJwt } from './jwt'

type IpApiResult = { query: string; lat?: number; lon?: number; city?: string }

// http (not https) is fine here: this runs in the Electron main process (not a
// browser), so mixed-content rules don't apply. ip-api.com free tier is HTTP-only.
const IP_API = 'http://ip-api.com/json/?fields=query,lat,lon,city'

export async function locateByIp(): Promise<{ lng: number; lat: number; city: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5_000)
  try {
    const res = await fetch(IP_API, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`ip-api HTTP ${res.status}`)
    const body = (await res.json()) as IpApiResult
    if (body.lat == null || body.lon == null) {
      throw new Error('ip-api returned no coordinates')
    }
    // ip-api names the longitude field `lon`; we expose it as `lng`. The city
    // fallback uses `lon` (the brief's draft referenced an undefined `body.lng`,
    // which would always yield an empty first component — corrected here).
    return { lng: body.lon, lat: body.lat, city: body.city || `${body.lon},${body.lat}` }
  } finally {
    clearTimeout(timer)
  }
}

// QWeather city-lookup entries carry lat/lon (strings) alongside the name. The
// reverse path only needs the name; geocodeCity() also needs the coordinates.
type GeoApiResult = { code?: string; location?: { name: string; lat?: string; lon?: string }[] }

export async function reverseGeocode(cfg: WeatherConfig, lng: number, lat: number): Promise<string> {
  const token = await signQWeatherJwt(cfg)
  const url = `${cfg.host.replace(/\/+$/, '')}/geo/v2/city/lookup?location=${lng},${lat}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`QWeather GeoAPI HTTP ${res.status}`)
  const body = (await res.json()) as GeoApiResult
  if (body.code !== '200' || !body.location?.length) {
    throw new Error(`QWeather GeoAPI code ${body.code ?? 'unknown'}`)
  }
  return body.location[0].name
}

// Forward-geocode a custom city name (e.g. "北京"/"Shanghai") to coordinates via
// the same QWeather GeoAPI endpoint (location param is the query string instead
// of lng,lat). Returns the first match's coords + canonical name. Throws on
// HTTP failure, a non-"200" QWeather code, or an unparseable lat/lon.
export async function geocodeCity(
  cfg: WeatherConfig,
  query: string
): Promise<{ lng: number; lat: number; name: string }> {
  const token = await signQWeatherJwt(cfg)
  const url = `${cfg.host.replace(/\/+$/, '')}/geo/v2/city/lookup?location=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`QWeather GeoAPI HTTP ${res.status}`)
  const body = (await res.json()) as GeoApiResult
  const top = body.location?.[0]
  if (body.code !== '200' || !top) {
    throw new Error(`QWeather GeoAPI code ${body.code ?? 'unknown'}`)
  }
  const lng = Number(top.lon)
  const lat = Number(top.lat)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new Error(`QWeather GeoAPI returned no coordinates for "${query}"`)
  }
  return { lng, lat, name: top.name }
}
