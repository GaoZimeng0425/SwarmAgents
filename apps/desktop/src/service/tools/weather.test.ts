import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolRunContext } from './registry'
import { getWeatherSpec } from './weather'

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  requestPermission: async () => 'grant',
  findPeers: () => [],
}
const tool = () => getWeatherSpec().build(ctx)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('get_weather tool', () => {
  it('requests wttr.in with a curl UA, location and clamped day option', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('Tokyo: ☀️ +20°C', { status: 200, headers: { 'content-type': 'text/plain' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await tool().execute('c', { location: 'Tokyo', days: 9 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://wttr.in/Tokyo?3Tm') // days clamped to wttr.in max of 3
    expect((init!.headers as Record<string, string>)['user-agent']).toMatch(/curl/)
    const first = res.content[0]
    expect(first.type === 'text' && first.text).toContain('Tokyo')
  })

  it('omits the day digit when days is not provided', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('weather', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await tool().execute('c', { location: 'Beijing' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://wttr.in/Beijing?Tm')
  })

  it('falls back to geo-IP (empty path) when no location is given', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('weather', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await tool().execute('c', {})
    expect(fetchMock.mock.calls[0][0]).toBe('https://wttr.in/?Tm')
  })

  it('surfaces an HTTP error as a result, not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unknown location', { status: 404, statusText: 'Not Found' }))
    )
    const res = await tool().execute('c', { location: 'Nowhereville' })
    expect((res.details as { error?: string }).error).toMatch(/404/)
  })

  it('surfaces a network error as a result, not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      })
    )
    const res = await tool().execute('c', { location: 'Tokyo' })
    expect((res.details as { error?: string }).error).toMatch(/boom/i)
  })
})
