import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { MainMethod, WeatherForecast } from '@swarm/protocol'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'weather' })

const MAX_OUTPUT = 8_000
const TIMEOUT_MS = 15_000
// wttr.in returns HTML for browser-like clients and plain text only for
// curl/wget-style agents — so a curl UA is required to get the text forecast.
// wttr.in is only used as a fallback when QWeather is not configured.
const USER_AGENT = 'curl/8.4.0 (SwarmAgents weather tool)'

type MainRpcFn = (method: MainMethod, args: unknown[]) => Promise<unknown>

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const WeatherParams = Type.Object({
  location: Type.Optional(
    Type.String({
      description:
        'Place to look up, e.g. "Tokyo", "Beijing", "New York", "94103", or "London,UK". ' +
        'Used only as a fallback (wttr.in) when QWeather is not configured. ' +
        'When QWeather is configured, the saved location from settings is used and this param is ignored.',
    })
  ),
  days: Type.Optional(
    Type.Number({
      description:
        'Forecast horizon, 0-3 (wttr.in fallback maximum): 0 = current conditions only, 1 = today, 2 = +tomorrow, ' +
        '3 = three days. Ignored when QWeather is configured (it returns a fixed 24h hourly forecast).',
    })
  ),
})

// ---- QWeather forecast formatting (primary path) ----

// Render a WeatherForecast into a compact plain-text report for the LLM.
// Includes current conditions, the next ~12 hours, active warnings, air
// quality, and life indices when present.
function formatForecast(f: WeatherForecast): string {
  const lines: string[] = []
  lines.push(`Location: ${f.location} (${f.source})`)

  // Current conditions (observed), distinct from hours[0] (forecast).
  if (f.now) {
    const n = f.now
    lines.push(
      `Now: ${n.text} ${n.temp}°C (feels ${n.feelsLike}°C), humidity ${n.humidity}%, ` +
        `wind ${n.windDir} force-${n.windScale} ${n.windSpeed}km/h, pressure ${n.pressure}hPa, ` +
        `visibility ${n.vis}km, precip ${n.precip}mm`
    )
  }

  // Hourly forecast — cap at 12 hours to keep the report concise.
  const hours = f.hours.slice(0, 12)
  if (hours.length > 0) {
    lines.push('Hourly:')
    for (const h of hours) {
      const pop = h.pop > 0 ? ` ${h.pop}%🌧` : ''
      lines.push(
        `  ${h.time}  ${h.text} ${h.tempC}°C  💧${h.precipMm}mm${pop}  💨${h.windDir} ${h.windScale}  humidity ${h.humidity}%`
      )
    }
  }

  // Active warnings (severity-coloured in the UI; here just title + level).
  if (f.warnings.length > 0) {
    lines.push('Warnings:')
    for (const w of f.warnings) {
      lines.push(`  ⚠ ${w.title} [${w.typeName}/${w.level}]`)
    }
  }

  // Air quality.
  if (f.air) {
    lines.push(
      `Air: AQI ${f.air.aqi} (${f.air.category}), primary ${f.air.primary}, PM2.5 ${f.air.pm2p5}, PM10 ${f.air.pm10}`
    )
  }

  // Minute-level precipitation nowcast (China-only; natural-language summary).
  if (f.minutely?.summary) {
    lines.push(`Minutely: ${f.minutely.summary}`)
  }

  // Life indices (exercise / car wash / clothing / UV, etc.).
  if (f.indices.length > 0) {
    lines.push('Indices:')
    for (const i of f.indices) {
      lines.push(`  ${i.name}: ${i.category} — ${i.text}`)
    }
  }

  return lines.join('\n')
}

// ---- wttr.in fallback (secondary path) ----

// Compose the wttr.in query options. `T` strips terminal color codes; `m`
// forces metric units; the leading digit (when present) caps the forecast days.
function buildWttrUrl(location: string, days?: number): string {
  const horizon = days === undefined ? '' : String(Math.min(Math.max(Math.trunc(days), 0), 3))
  return `https://wttr.in/${encodeURIComponent(location)}?${horizon}Tm`
}

async function fetchWttr(location: string, days?: number): Promise<Result> {
  const url = buildWttrUrl(location, days)
  log.info({ msg: 'get_weather wttr.in fallback', location: location || '(auto)', days })
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    })
    const body = (await res.text()).trim()
    if (!res.ok) {
      log.warn({ msg: 'get_weather wttr.in http error', status: res.status })
      return err(`wttr.in ${res.status}: ${body.slice(0, 200) || res.statusText}`)
    }
    let text = body
    const truncated = text.length > MAX_OUTPUT
    if (truncated) text = `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`
    log.info({ msg: 'get_weather wttr.in ok', status: res.status, truncated })
    return ok(text || '(empty response)', { source: 'wttr.in', location: location || '(auto)', truncated })
  } catch (e) {
    const msg =
      e instanceof Error && e.name === 'TimeoutError'
        ? `timed out after ${TIMEOUT_MS}ms`
        : e instanceof Error
          ? e.message
          : String(e)
    log.error({ msg: 'get_weather wttr.in threw', err: msg })
    return err(msg)
  }
}

// ---- tool spec ----

export function getWeatherSpec(mainRpc?: MainRpcFn): ToolSpec {
  return {
    group: 'weather',
    name: 'get_weather',
    risk: 'low', // read-only request to a fixed public host
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'get_weather',
      label: 'Get Weather',
      description:
        'Get the current weather and short-range forecast. ' +
        'Uses the QWeather service configured in settings (same source as the dashboard card, ' +
        'honoring the saved location) when available; falls back to wttr.in otherwise. ' +
        'Returns a plain-text report (current conditions, hourly forecast, warnings, air quality, indices).',
      parameters: WeatherParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { location?: string; days?: number }

        // Primary path: QWeather via the service→main RPC. No GPS coords (the
        // service worker has none), so the service resolves location by its own
        // priority: saved location > IP — identical to the dashboard card when
        // it has no GPS fix.
        if (mainRpc) {
          try {
            const r = (await mainRpc('weather.get_forecast', [null, null])) as
              | { ok: true; forecast: WeatherForecast }
              | { ok: false; code: string; message: string }
            if (r.ok) {
              let text = formatForecast(r.forecast)
              const truncated = text.length > MAX_OUTPUT
              if (truncated) text = `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`
              log.info({
                msg: 'get_weather ok',
                source: 'qweather',
                location: r.forecast.location,
                truncated,
              })
              return ok(text, {
                source: 'qweather',
                location: r.forecast.location,
                truncated,
              })
            }
            // not_configured → fall through to wttr.in. Other codes (locate_failed,
            // fetch_failed) also fall through so the tool degrades gracefully.
            log.warn({ msg: 'get_weather qweather failed, falling back to wttr.in', code: r.code, message: r.message })
          } catch (e) {
            log.warn({
              msg: 'get_weather qweather rpc threw, falling back to wttr.in',
              err: e instanceof Error ? e.message : String(e),
            })
          }
        }

        // Fallback: wttr.in with the agent-supplied location (or IP geo).
        const location = (p.location ?? '').trim()
        return fetchWttr(location, p.days)
      },
    }),
  }
}
