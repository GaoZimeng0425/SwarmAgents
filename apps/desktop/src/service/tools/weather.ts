import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'

import type { ToolRunContext, ToolSpec } from './registry'

const log = createLogger({ process: 'service' }).child({ component: 'weather' })

const MAX_OUTPUT = 8_000
const TIMEOUT_MS = 15_000
// wttr.in returns HTML for browser-like clients and plain text only for
// curl/wget-style agents — so a curl UA is required to get the text forecast.
const USER_AGENT = 'curl/8.4.0 (SwarmAgents weather tool)'

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
        'Omit to use the location inferred from the network IP.',
    })
  ),
  days: Type.Optional(
    Type.Number({
      description:
        'Forecast horizon, 0-3 (wttr.in maximum): 0 = current conditions only, 1 = today, 2 = +tomorrow, ' +
        '3 = three days. Omit for the default 3-day forecast.',
    })
  ),
})

// Compose the wttr.in query options. `T` strips terminal color codes; `m`
// forces metric units; the leading digit (when present) caps the forecast days.
function buildUrl(location: string, days?: number): string {
  const horizon = days === undefined ? '' : String(Math.min(Math.max(Math.trunc(days), 0), 3))
  return `https://wttr.in/${encodeURIComponent(location)}?${horizon}Tm`
}

export function getWeatherSpec(): ToolSpec {
  return {
    group: 'weather',
    name: 'get_weather',
    risk: 'low', // read-only request to a fixed public host
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'get_weather',
      label: 'Get Weather',
      description:
        'Get the current weather and short-range forecast for a location from wttr.in, as a plain-text report. ' +
        'Pass `location` (city/zip/airport code) and optionally `days` (0-3) to limit the forecast horizon.',
      parameters: WeatherParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { location?: string; days?: number }
        const location = (p.location ?? '').trim()
        const url = buildUrl(location, p.days)
        log.info({ msg: 'get_weather start', location: location || '(auto)', days: p.days })
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'user-agent': USER_AGENT },
          })
          const body = (await res.text()).trim()
          if (!res.ok) {
            log.warn({ msg: 'get_weather http error', status: res.status })
            return err(`wttr.in ${res.status}: ${body.slice(0, 200) || res.statusText}`)
          }
          let text = body
          const truncated = text.length > MAX_OUTPUT
          if (truncated) text = `${text.slice(0, MAX_OUTPUT)}\n…[truncated]`
          log.info({ msg: 'get_weather ok', status: res.status, truncated })
          return ok(text || '(empty response)', { location: location || '(auto)', truncated })
        } catch (e) {
          const msg =
            e instanceof Error && e.name === 'TimeoutError'
              ? `timed out after ${TIMEOUT_MS}ms`
              : e instanceof Error
                ? e.message
                : String(e)
          log.error({ msg: 'get_weather threw', err: msg })
          return err(msg)
        }
      },
    }),
  }
}
