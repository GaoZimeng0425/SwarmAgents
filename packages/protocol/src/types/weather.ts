import { z } from 'zod'

// QWeather (和风天气) config. The private key is the Ed25519 PEM content as a
// string (not a file path) so it travels through safeStorage like other module
// secrets and never touches disk in cleartext.
export const WeatherConfig = z.object({
  host: z.string().url().default('https://devapi.qweather.com'),
  projectId: z.string().default(''), // JWT sub
  credentialId: z.string().default(''), // JWT kid
  privateKeyPem: z.string().default(''),
  // Optional custom location (city name, e.g. "北京"/"Shanghai"). When set it
  // takes priority over GPS/IP: main geocodes it via QWeather GeoAPI. Not a
  // secret, so it round-trips to the renderer in WeatherConfigView unredacted.
  location: z.string().default(''),
})
export type WeatherConfig = z.infer<typeof WeatherConfig>

export function defaultWeatherConfig(): WeatherConfig {
  return WeatherConfig.parse({})
}

// Renderer-visible projection of the config. The private key is replaced by a
// hasPrivateKey boolean so the PEM never crosses the IPC boundary on read —
// matches the providers/web-search/gmail redaction pattern. setConfig still
// accepts the full WeatherConfig (write path) when the user pastes a new key.
export const WeatherConfigView = z.object({
  host: z.string(),
  projectId: z.string(),
  credentialId: z.string(),
  hasPrivateKey: z.boolean(),
  location: z.string(),
})
export type WeatherConfigView = z.infer<typeof WeatherConfigView>

// On-disk wrapper. Matches the `{ <module>: <config> }` shape used by
// web-search/gmail so the store layer is identical.
export const WeatherConfigOnDisk = z.object({ weather: WeatherConfig })
export type WeatherConfigOnDisk = z.infer<typeof WeatherConfigOnDisk>

export function defaultWeatherConfigOnDisk(): WeatherConfigOnDisk {
  return { weather: defaultWeatherConfig() }
}

// One normalized hour of the forecast. Timestamps are already converted to the
// location's local timezone by the normalizer, so the renderer does no timezone
// math. `pop` (probability of precipitation, %) and `precipMm` (amount) both
// come from the /v7/weather/24h endpoint; a missing field normalizes to 0.
export const WeatherHour = z.object({
  time: z.string(),
  tempC: z.number(),
  icon: z.string(),
  text: z.string(),
  precipMm: z.number(),
  pop: z.number(),
  humidity: z.number(),
  windScale: z.string(),
  windDir: z.string(),
  pressure: z.number(),
})
export type WeatherHour = z.infer<typeof WeatherHour>

// One active weather warning (/v7/warning/now). `severityColor` (Yellow/Blue/
// Orange/Red) drives the card's severity styling; `text` is the full advisory.
export const WeatherWarning = z.object({
  id: z.string(),
  title: z.string(),
  typeName: z.string(),
  level: z.string(),
  severityColor: z.string(),
  text: z.string(),
  pubTime: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.string(),
})
export type WeatherWarning = z.infer<typeof WeatherWarning>

// One life index (/v7/indices/1d) — e.g. 运动/洗车/穿衣/紫外线. `category` is the
// short verdict ("较不宜"), `text` the advice.
export const WeatherIndex = z.object({
  type: z.string(),
  name: z.string(),
  level: z.string(),
  category: z.string(),
  text: z.string(),
})
export type WeatherIndex = z.infer<typeof WeatherIndex>

// Current air quality (/v7/air/now). `primary` is the dominant pollutant code
// (e.g. "O3"); concentration fields are µg/m³ (co is mg/m³).
export const AirQuality = z.object({
  aqi: z.number(),
  category: z.string(),
  primary: z.string(),
  pm2p5: z.number(),
  pm10: z.number(),
  no2: z.number(),
  so2: z.number(),
  co: z.number(),
  o3: z.number(),
  pubTime: z.string(),
})
export type AirQuality = z.infer<typeof AirQuality>

// Minute-level precipitation nowcast (/v7/minutely/5m) — next 2h in 5-min steps.
// `summary` is QWeather's natural-language line ("80分钟后雨就停了"). China-only;
// null when unavailable.
export const MinutelyPoint = z.object({
  time: z.string(),
  precipMm: z.number(),
  type: z.string(), // "rain" | "snow" | "none"
})
export type MinutelyPoint = z.infer<typeof MinutelyPoint>

export const Minutely = z.object({
  summary: z.string(),
  points: z.array(MinutelyPoint).max(24),
})
export type Minutely = z.infer<typeof Minutely>

// Forecast view-model crossing the IPC boundary. This is NEVER the raw QWeather
// payload — the main process normalizes first, insulating the renderer from
// upstream field renames. `source` tells the UI which locator won (gps/ip).
// warnings/indices default to [] and air/minutely to null when a supplementary
// endpoint fails or has no data — the core hourly forecast still renders.
export const WeatherForecast = z.object({
  location: z.string(),
  lng: z.number(),
  lat: z.number(),
  source: z.enum(['gps', 'ip', 'custom']),
  fetchedAt: z.number(),
  hours: z.array(WeatherHour).max(24),
  warnings: z.array(WeatherWarning),
  indices: z.array(WeatherIndex),
  air: AirQuality.nullable(),
  minutely: Minutely.nullable(),
})
export type WeatherForecast = z.infer<typeof WeatherForecast>
