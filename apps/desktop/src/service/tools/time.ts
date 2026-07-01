import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const TimeParams = Type.Object({
  timezone: Type.Optional(
    Type.String({
      description: 'IANA timezone name (e.g. "Asia/Tokyo", "America/New_York"). Omit for the host\'s local timezone.',
    })
  ),
})

// Build a human-readable, timezone-aware rendering of `now`. Throws RangeError
// for an unknown timezone (caught by the caller and surfaced as a tool error).
function formatNow(now: Date, timezone?: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
    ...(timezone ? { timeZone: timezone } : {}),
  })
  return fmt.format(now)
}

export function currentTimeSpec(): ToolSpec {
  return {
    group: 'time',
    name: 'current_time',
    risk: 'low', // read-only clock; touches nothing
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'current_time',
      label: 'Current Time',
      description:
        'Return the current date and time. Optionally pass an IANA `timezone` (e.g. "Asia/Tokyo") to render ' +
        "it in that zone; otherwise the host's local timezone is used. Always includes the UTC ISO timestamp.",
      parameters: TimeParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { timezone?: string }
        const now = new Date()
        try {
          const local = formatNow(now, p.timezone)
          const zone = p.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
          const text = `${local}\nUTC (ISO 8601): ${now.toISOString()}`
          return ok(text, { iso: now.toISOString(), epochMs: now.getTime(), timezone: zone })
        } catch (e) {
          // Intl throws RangeError on an unknown timezone identifier.
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
  }
}
