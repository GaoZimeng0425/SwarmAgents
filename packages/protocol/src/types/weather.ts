import { z } from 'zod'

// QWeather (和风天气) config. The private key is the Ed25519 PEM content as a
// string (not a file path) so it travels through safeStorage like other module
// secrets and never touches disk in cleartext.
export const WeatherConfig = z.object({
  host: z.string().url().default('https://devapi.qweather.com'),
  projectId: z.string().default(''), // JWT sub
  credentialId: z.string().default(''), // JWT kid
  privateKeyPem: z.string().default(''),
})
export type WeatherConfig = z.infer<typeof WeatherConfig>

export function defaultWeatherConfig(): WeatherConfig {
  return WeatherConfig.parse({})
}

// On-disk wrapper. Matches the `{ <module>: <config> }` shape used by
// web-search/gmail so the store layer is identical.
export const WeatherConfigOnDisk = z.object({ weather: WeatherConfig })
export type WeatherConfigOnDisk = z.infer<typeof WeatherConfigOnDisk>

export function defaultWeatherConfigOnDisk(): WeatherConfigOnDisk {
  return { weather: defaultWeatherConfig() }
}

// One normalized hour of the grid-point forecast. Timestamps are already
// converted to the user's local timezone by the normalizer, so the renderer
// does no timezone math. `pop` is not guaranteed by the grid-hourly endpoint
// and defaults to 0 when the source omits it.
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
  feelsLikeC: z.number(),
})
export type WeatherHour = z.infer<typeof WeatherHour>

// Forecast view-model crossing the IPC boundary. This is NEVER the raw QWeather
// payload — the main process normalizes first, insulating the renderer from
// upstream field renames. `source` tells the UI which locator won (gps/ip).
export const WeatherForecast = z.object({
  location: z.string(),
  lng: z.number(),
  lat: z.number(),
  source: z.enum(['gps', 'ip']),
  fetchedAt: z.number(),
  hours: z.array(WeatherHour).max(24),
})
export type WeatherForecast = z.infer<typeof WeatherForecast>
