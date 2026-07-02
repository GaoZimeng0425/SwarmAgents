// src/main/calendar/api.ts
//
// Hand-rolled Google Calendar REST client (mirrors gmail/api.ts shape):
// listUpcoming + getPrimaryCalendarEmail. 401 -> refresh -> retry once.
// 429/5xx -> exponential backoff (max 3). Normalises Google JSON -> GoogleEventRow.
import { createLogger } from '@shared/logger'

import type { GoogleEventRow } from './cache'

const log = createLogger({ process: 'main' }).child({ component: 'calendar-api' })

const BASE = 'https://calendar-json.googleapis.com/calendar/v3'

type Auth = { getAccessToken(): Promise<string>; refreshAccessToken(): Promise<void> }

export type CalendarApi = {
  listUpcoming(input: {
    calendarId: string
    fromMs: number
    toMs: number
    maxResults?: number
  }): Promise<GoogleEventRow[]>
  getPrimaryCalendarEmail(): Promise<string>
}

function parseAllDayDate(s: string): number {
  // 'yyyy-MM-dd' -> local-midnight epoch ms (matches how the view groups by day).
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
}

function normalise(calendarId: string, raw: Record<string, unknown>): GoogleEventRow {
  const start = (raw.start ?? {}) as { dateTime?: string; date?: string }
  const end = (raw.end ?? {}) as { dateTime?: string; date?: string }
  const allDay = !!start.date
  const startMs = start.dateTime ? Date.parse(start.dateTime) : start.date ? parseAllDayDate(start.date) : 0
  const endMs = end.dateTime ? Date.parse(end.dateTime) : end.date ? parseAllDayDate(end.date) : startMs
  const attendees = ((raw.attendees ?? []) as { email?: string }[]).map((a) => a.email).filter((x): x is string => !!x)
  const sourceId = String(raw.id ?? '')
  return {
    id: `${calendarId}:${sourceId}`,
    sourceId,
    calendarId,
    title: String(raw.summary ?? '(untitled)'),
    description: raw.description == null ? null : String(raw.description),
    location: raw.location == null ? null : String(raw.location),
    startMs,
    endMs,
    allDay,
    attendees,
  }
}

export function createApi(auth: Auth): CalendarApi {
  let refreshing = false

  async function request(path: string): Promise<Record<string, unknown>> {
    const url = path.startsWith('http') ? path : `${BASE}${path}`
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await auth.getAccessToken()
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (res.status === 401 && !refreshing) {
        refreshing = true
        try {
          await auth.refreshAccessToken()
        } finally {
          refreshing = false
        }
        continue // retry with the refreshed token
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = 2 ** attempt * 500
        log.warn({ msg: 'calendar api backoff', status: res.status, wait })
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      if (!res.ok) throw new Error(`calendar api ${res.status}: ${await res.text()}`)
      return (await res.json()) as Record<string, unknown>
    }
    throw new Error(`calendar api exhausted retries: ${path}`)
  }

  return {
    async listUpcoming({ calendarId, fromMs, toMs, maxResults = 250 }) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        maxResults: String(maxResults),
      })
      const json = await request(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`)
      const items = ((json.items ?? []) as Record<string, unknown>[]).map((r) => normalise(calendarId, r))
      log.debug({ msg: 'calendar listUpcoming', count: items.length })
      return items
    },
    async getPrimaryCalendarEmail() {
      const json = await request('/users/me/calendarList')
      const items = (json.items ?? []) as { primary?: boolean; id: string }[]
      const primary = items.find((i) => i.primary) ?? items[0]
      if (!primary) throw new Error('no primary calendar found')
      return primary.id
    },
  }
}
