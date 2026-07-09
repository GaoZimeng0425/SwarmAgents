import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApi } from './api'

const baseEventsJson = {
  items: [
    {
      id: 'evt-1',
      summary: 'Standup',
      location: 'Zoom',
      description: 'Daily',
      start: { dateTime: '2026-07-02T09:00:00Z' },
      end: { dateTime: '2026-07-02T09:30:00Z' },
      attendees: [{ email: 'a@x.com' }],
    },
    {
      id: 'evt-2',
      summary: 'PTO',
      start: { date: '2026-07-03' },
      end: { date: '2026-07-04' },
    },
  ],
}

describe('calendar api', () => {
  afterEach(() => vi.restoreAllMocks())

  it('listUpcoming sends the right query and normalises rows', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(baseEventsJson), { status: 200 }) as Response)
    const api = createApi({
      getAccessToken: async () => 'TOKEN',
      refreshAccessToken: async () => {},
    })
    const rows = await api.listUpcoming({
      calendarId: 'primary',
      fromMs: Date.parse('2026-07-02T00:00:00Z'),
      toMs: Date.parse('2026-07-09T00:00:00Z'),
      maxResults: 50,
    })
    expect(rows).toHaveLength(2)
    const standup = rows.find((r) => r.sourceId === 'evt-1')!
    expect(standup.title).toBe('Standup')
    expect(standup.allDay).toBe(false)
    expect(standup.attendees).toEqual(['a@x.com'])
    expect(standup.id).toBe('primary:evt-1')
    const pto = rows.find((r) => r.sourceId === 'evt-2')!
    expect(pto.allDay).toBe(true)

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/calendars/primary/events')
    expect(url).toContain('singleEvents=true')
    expect(url).toContain('orderBy=startTime')
    expect(url).toContain('timeMin=')
    expect(url).toContain('timeMax=')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
  })

  it('listUpcoming follows nextPageToken across pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      const body = url.includes('pageToken=TOK')
        ? { items: [{ id: 'evt-2', summary: 'Page 2', start: { date: '2026-07-03' }, end: { date: '2026-07-04' } }] }
        : {
            items: [
              {
                id: 'evt-1',
                summary: 'Page 1',
                start: { dateTime: '2026-07-02T09:00:00Z' },
                end: { dateTime: '2026-07-02T09:30:00Z' },
              },
            ],
            nextPageToken: 'TOK',
          }
      return new Response(JSON.stringify(body), { status: 200 }) as Response
    })
    const api = createApi({ getAccessToken: async () => 'TOKEN', refreshAccessToken: async () => {} })
    const rows = await api.listUpcoming({ calendarId: 'primary', fromMs: 0, toMs: 1, maxResults: 1 })
    expect(rows.map((r) => r.sourceId)).toEqual(['evt-1', 'evt-2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('pageToken')
    expect(String(fetchMock.mock.calls[1][0])).toContain('pageToken=TOK')
  })

  it('getPrimaryCalendarEmail returns the primary calendar id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [{ primary: true, id: 'user@example.com' }] }), {
        status: 200,
      }) as Response
    )
    const api = createApi({
      getAccessToken: async () => 'TOKEN',
      refreshAccessToken: async () => {},
    })
    expect(await api.getPrimaryCalendarEmail()).toBe('user@example.com')
  })

  it('refreshes once on 401 then retries', async () => {
    let calls = 0
    const refresh = vi.fn(async () => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      if (calls === 1) return new Response('unauth', { status: 401 }) as Response
      return new Response(JSON.stringify({ items: [] }), { status: 200 }) as Response
    })
    const api = createApi({ getAccessToken: async () => 'TOKEN', refreshAccessToken: refresh })
    const rows = await api.listUpcoming({ calendarId: 'primary', fromMs: 0, toMs: 1 })
    expect(rows).toEqual([])
    expect(refresh).toHaveBeenCalledOnce()
  })
})
