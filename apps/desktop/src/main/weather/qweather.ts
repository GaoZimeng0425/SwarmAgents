// QWeather grid-hourly forecast client + normalizer. The fetcher signs a JWT
// (jwt.ts) and GETs /v7/grid-forecast/24h?location=lng,lat; the normalizer
// converts the raw `hourly` payload into the WeatherHour view-model, turning
// UTC fxTime into the user's local timezone and defaulting pop->0 when absent
// (the grid-hourly endpoint does not guarantee pop).
import type { WeatherConfig, WeatherForecast, WeatherHour } from '@swarm/protocol'

import { signQWeatherJwt } from './jwt'

// Raw shape of one entry in a QWeather /v7/grid-forecast/24h `hourly` array.
// Kept loose (string fields) because QWeather returns everything as strings.
type RawHour = {
  fxTime?: string
  temp?: string
  icon?: string
  text?: string
  windScale?: string
  windDir?: string
  pop?: string
  precip?: string
  humidity?: string
  pressure?: string
  feelsLike?: string
}

const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Convert a raw QWeather hourly array into WeatherHour[] (pure). */
export function normalizeHourly(raw: RawHour[]): WeatherHour[] {
  const out: WeatherHour[] = []
  for (const r of raw) {
    if (!r.fxTime) continue
    const d = new Date(r.fxTime)
    if (Number.isNaN(d.getTime())) continue
    out.push({
      time: d.toString().includes('GMT')
        ? // toISOString drops offset; format with the local offset instead.
          new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
            .toISOString()
            .replace('Z', formatOffset(d))
        : d.toISOString(),
      tempC: num(r.temp),
      icon: r.icon ?? '',
      text: r.text ?? '',
      precipMm: num(r.precip),
      pop: num(r.pop),
      humidity: num(r.humidity),
      windScale: r.windScale ?? '',
      windDir: r.windDir ?? '',
      pressure: num(r.pressure),
      feelsLikeC: num(r.feelsLike),
    })
  }
  return out
}

// Build a +HH:MM offset string for the renderer-friendly ISO form.
function formatOffset(d: Date): string {
  const off = -d.getTimezoneOffset() // minutes; positive east of UTC
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

type FetchOpts = {
  config: WeatherConfig
  lng: number
  lat: number
  source: 'gps' | 'ip'
  locationLabel: string
}

// GET {host}/v7/grid-forecast/24h?location=lng,lat with a Bearer JWT.
// Returns the normalized forecast; throws on non-200 HTTP or QWeather code !== "200".
export async function fetchGridHourly(opts: FetchOpts): Promise<WeatherForecast> {
  const { config, lng, lat, source, locationLabel } = opts
  const token = await signQWeatherJwt(config)
  const url = `${config.host.replace(/\/+$/, '')}/v7/grid-forecast/24h?location=${lng},${lat}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new Error(`QWeather HTTP ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { code?: string; hourly?: RawHour[] }
  if (body.code !== '200') {
    throw new Error(`QWeather code ${body.code ?? 'unknown'}`)
  }
  return {
    location: locationLabel,
    lng,
    lat,
    source,
    fetchedAt: Date.now(),
    hours: normalizeHourly(body.hourly ?? []),
  }
}
