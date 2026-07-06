// QWeather API client + normalizers. Every fetcher signs a JWT (jwt.ts) and
// GETs a /v7/... endpoint via the shared qwGet helper, then normalizes the raw
// (all-string) payload into the protocol view-models so the renderer never sees
// upstream field names. fetchHourly is the core forecast; fetchWarnings /
// fetchIndices / fetchAir / fetchMinutely are supplementary (the service treats
// their failures as non-fatal).
import type {
  AirQuality,
  Minutely,
  WeatherConfig,
  WeatherForecast,
  WeatherHour,
  WeatherIndex,
  WeatherNow,
  WeatherWarning,
} from '@swarm/protocol'

import { signQWeatherJwt } from './jwt'

const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// Sign a JWT, GET {host}{path}, and return the parsed body. Throws on non-200
// HTTP or a QWeather `code` other than "200" (some endpoints omit `code`, e.g.
// the airquality v1 API — callers that hit those must not use qwGet).
async function qwGet(config: WeatherConfig, path: string): Promise<Record<string, unknown>> {
  const token = await signQWeatherJwt(config)
  const url = `${config.host.replace(/\/+$/, '')}${path}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`QWeather HTTP ${res.status} ${res.statusText}`)
  const body = (await res.json()) as Record<string, unknown>
  if (body.code !== '200') throw new Error(`QWeather code ${(body.code as string) ?? 'unknown'}`)
  return body
}

// ── Hourly forecast (/v7/weather/24h) ──────────────────────────────────────

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
          new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().replace('Z', formatOffset(d))
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

// ── Current observation (/v7/weather/now) ──────────────────────────────────

type RawNow = {
  obsTime?: string
  temp?: string
  feelsLike?: string
  icon?: string
  text?: string
  humidity?: string
  windScale?: string
  windDir?: string
  windSpeed?: string
  pressure?: string
  vis?: string
  precip?: string
}

/** Convert a raw QWeather `now` object into WeatherNow (pure). null when absent. */
export function normalizeNow(raw: RawNow | undefined): WeatherNow | null {
  if (!raw?.obsTime) return null
  const d = new Date(raw.obsTime)
  const obsTime = Number.isNaN(d.getTime())
    ? raw.obsTime
    : d.toString().includes('GMT')
      ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().replace('Z', formatOffset(d))
      : d.toISOString()
  return {
    temp: num(raw.temp),
    feelsLike: num(raw.feelsLike),
    icon: raw.icon ?? '',
    text: raw.text ?? '',
    humidity: num(raw.humidity),
    windScale: raw.windScale ?? '',
    windDir: raw.windDir ?? '',
    windSpeed: num(raw.windSpeed),
    pressure: num(raw.pressure),
    vis: num(raw.vis),
    precip: num(raw.precip),
    obsTime,
  }
}

// GET {host}/v7/weather/now?location=lng,lat → WeatherNow | null. Supplementary
// (non-fatal): the service treats a throw as `now = null`.
export async function fetchNow(config: WeatherConfig, lng: number, lat: number): Promise<WeatherNow | null> {
  const body = await qwGet(config, `/v7/weather/now?location=${lng},${lat}`)
  return normalizeNow(body.now as RawNow | undefined)
}

type FetchOpts = {
  config: WeatherConfig
  lng: number
  lat: number
  source: 'gps' | 'ip' | 'custom'
  locationLabel: string
}

// GET {host}/v7/weather/24h?location=lng,lat. Returns the core forecast with
// empty supplementary fields; the service fills warnings/indices/air/minutely.
export async function fetchHourly(opts: FetchOpts): Promise<WeatherForecast> {
  const { config, lng, lat, source, locationLabel } = opts
  const body = await qwGet(config, `/v7/weather/24h?location=${lng},${lat}`)
  return {
    location: locationLabel,
    lng,
    lat,
    source,
    fetchedAt: Date.now(),
    hours: normalizeHourly((body.hourly as RawHour[]) ?? []),
    warnings: [],
    indices: [],
    air: null,
    minutely: null,
    now: null,
  }
}

// ── Warnings (/v7/warning/now) ──────────────────────────────────────────────

type RawWarning = {
  id?: string
  title?: string
  typeName?: string
  level?: string
  severityColor?: string
  text?: string
  pubTime?: string
  startTime?: string
  endTime?: string
  status?: string
}

/** Normalize the QWeather `warning` array into WeatherWarning[] (pure). */
export function normalizeWarnings(raw: RawWarning[]): WeatherWarning[] {
  return raw.map((w) => ({
    id: w.id ?? '',
    title: w.title ?? '',
    typeName: w.typeName ?? '',
    level: w.level ?? '',
    severityColor: w.severityColor ?? '',
    text: w.text ?? '',
    pubTime: w.pubTime ?? '',
    startTime: w.startTime ?? '',
    endTime: w.endTime ?? '',
    status: w.status ?? '',
  }))
}

export async function fetchWarnings(config: WeatherConfig, lng: number, lat: number): Promise<WeatherWarning[]> {
  const body = await qwGet(config, `/v7/warning/now?location=${lng},${lat}`)
  return normalizeWarnings((body.warning as RawWarning[]) ?? [])
}

// ── Life indices (/v7/indices/1d) ───────────────────────────────────────────

type RawIndex = { type?: string; name?: string; level?: string; category?: string; text?: string }

/** Normalize the QWeather `daily` indices array into WeatherIndex[] (pure). */
export function normalizeIndices(raw: RawIndex[]): WeatherIndex[] {
  return raw.map((i) => ({
    type: i.type ?? '',
    name: i.name ?? '',
    level: i.level ?? '',
    category: i.category ?? '',
    text: i.text ?? '',
  }))
}

// type=1,2,3,5,8,9 → 运动/洗车/穿衣/紫外线/舒适度/感冒 (the six the card shows).
export async function fetchIndices(config: WeatherConfig, lng: number, lat: number): Promise<WeatherIndex[]> {
  const body = await qwGet(config, `/v7/indices/1d?type=1,2,3,5,8,9&location=${lng},${lat}`)
  return normalizeIndices((body.daily as RawIndex[]) ?? [])
}

// ── Air quality (/v7/air/now) ───────────────────────────────────────────────

type RawAir = {
  aqi?: string
  category?: string
  primary?: string
  pm2p5?: string
  pm10?: string
  no2?: string
  so2?: string
  co?: string
  o3?: string
  pubTime?: string
}

/** Normalize the QWeather air `now` object into AirQuality, or null if absent. */
export function normalizeAir(raw: RawAir | undefined): AirQuality | null {
  if (!raw) return null
  return {
    aqi: num(raw.aqi),
    category: raw.category ?? '',
    primary: raw.primary ?? '',
    pm2p5: num(raw.pm2p5),
    pm10: num(raw.pm10),
    no2: num(raw.no2),
    so2: num(raw.so2),
    co: num(raw.co),
    o3: num(raw.o3),
    pubTime: raw.pubTime ?? '',
  }
}

export async function fetchAir(config: WeatherConfig, lng: number, lat: number): Promise<AirQuality | null> {
  const body = await qwGet(config, `/v7/air/now?location=${lng},${lat}`)
  return normalizeAir(body.now as RawAir | undefined)
}

// ── Minutely precipitation (/v7/minutely/5m) ────────────────────────────────

type RawMinutely = { summary?: string; minutely?: { fxTime?: string; precip?: string; type?: string }[] }

/** Normalize the QWeather minutely payload into Minutely, or null if absent. */
export function normalizeMinutely(raw: RawMinutely): Minutely | null {
  if (!raw.minutely?.length) return null
  return {
    summary: raw.summary ?? '',
    points: raw.minutely.slice(0, 24).map((m) => ({
      time: m.fxTime ?? '',
      precipMm: num(m.precip),
      type: m.type ?? 'none',
    })),
  }
}

export async function fetchMinutely(config: WeatherConfig, lng: number, lat: number): Promise<Minutely | null> {
  const body = await qwGet(config, `/v7/minutely/5m?location=${lng},${lat}`)
  return normalizeMinutely(body as RawMinutely)
}
