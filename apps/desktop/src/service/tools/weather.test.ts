import type { WeatherForecast } from '@swarm/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolRunContext } from './registry'
import { getWeatherSpec } from './weather'

const ctx: ToolRunContext = {
  sessionId: 's',
  taskId: 't',
  spawnChild: async () => ({ runId: 'c', status: 'completed', summary: '', artifacts: [] }),
  requestPermission: async () => 'grant',
  findPeers: () => [],
}
const tool = (callMain?: Parameters<typeof getWeatherSpec>[0]) => getWeatherSpec(callMain).build(ctx)

afterEach(() => {
  vi.unstubAllGlobals()
})

// A minimal-but-realistic QWeather forecast for the primary-path assertions.
const sampleForecast: WeatherForecast = {
  location: '北京市',
  lng: 116.4,
  lat: 39.9,
  source: 'custom',
  fetchedAt: 1_700_000_000_000,
  hours: [
    {
      time: '2024-01-01T12:00+08:00',
      tempC: 5,
      icon: '100',
      text: '晴',
      precipMm: 0,
      pop: 0,
      humidity: 30,
      windScale: '2',
      windDir: '北',
      pressure: 1015,
    },
  ],
  warnings: [],
  indices: [],
  air: null,
  minutely: null,
  now: {
    temp: 6,
    feelsLike: 3,
    icon: '100',
    text: '晴',
    humidity: 32,
    windScale: '2',
    windDir: '北',
    windSpeed: 10,
    pressure: 1015,
    vis: 15,
    precip: 0,
    obsTime: '2024-01-01T11:00+08:00',
  },
}

describe('get_weather tool — QWeather primary path', () => {
  it('calls weather.get_forecast via callMain and formats the forecast', async () => {
    const callMain = vi.fn(async () => ({ ok: true, forecast: sampleForecast }))

    const res = await tool(callMain).execute('c', {})

    expect(callMain).toHaveBeenCalledWith('weather.get_forecast', [null, null])
    const text = res.content[0]
    expect(text.type === 'text' && text.text).toContain('北京市')
    expect(text.type === 'text' && text.text).toContain('晴')
    expect(text.type === 'text' && text.text).toContain('feels 3°C')
    expect((res.details as { source: string }).source).toBe('qweather')
  })

  it('falls back to wttr.in when QWeather is not configured', async () => {
    const callMain = vi.fn(async () => ({ ok: false, code: 'not_configured', message: 'not configured' }))
    const fetchMock = vi.fn(async (_url: string) => new Response('wttr report', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await tool(callMain).execute('c', { location: 'Tokyo' })

    expect(callMain).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][0]).toBe('https://wttr.in/Tokyo?Tm')
    const text = res.content[0]
    expect(text.type === 'text' && text.text).toContain('wttr report')
    expect((res.details as { source: string }).source).toBe('wttr.in')
  })

  it('falls back to wttr.in when the callMain throws', async () => {
    const callMain = vi.fn(async () => {
      throw new Error('rpc transport closed')
    })
    const fetchMock = vi.fn(async (_url: string) => new Response('fallback', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await tool(callMain).execute('c', { location: 'Beijing' })

    expect(fetchMock).toHaveBeenCalled()
    expect((res.details as { source: string }).source).toBe('wttr.in')
  })
})

describe('get_weather tool — wttr.in fallback only (no callMain injected)', () => {
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
