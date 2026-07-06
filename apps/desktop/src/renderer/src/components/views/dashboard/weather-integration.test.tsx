// @vitest-environment jsdom
// Integration test: does NOT mock @/hooks/use-weather. Proves the shared-store
// fix — the strip fetches once, and the drawer/detail (mounted later) read the
// SAME forecast rather than an independent, still-null state instance.
import '@testing-library/jest-dom/vitest'
import type { WeatherConfigView, WeatherForecast } from '@swarm/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-settings-nav', () => ({ useSettingsNav: () => ({ openSettings: vi.fn() }) }))

const config: WeatherConfigView = {
  host: 'https://devapi.qweather.com',
  projectId: 'p',
  credentialId: 'c',
  hasPrivateKey: true,
  location: '',
}

const forecast: WeatherForecast = {
  location: '北京市 · 朝阳区',
  lng: 116.4,
  lat: 39.9,
  source: 'ip',
  fetchedAt: Date.now(),
  warnings: [],
  indices: [],
  air: null,
  minutely: null,
  now: {
    temp: 28,
    feelsLike: 31,
    icon: '101',
    text: '多云',
    humidity: 58,
    windScale: '3',
    windDir: '东南风',
    windSpeed: 12,
    pressure: 1006,
    vis: 16,
    precip: 0,
    obsTime: '2026-07-07T10:00:00+08:00',
  },
  hours: [
    {
      time: '2026-07-07T10:00:00+08:00',
      tempC: 27,
      icon: '101',
      text: '多云',
      precipMm: 0,
      pop: 20,
      humidity: 58,
      windScale: '3',
      windDir: '东南风',
      pressure: 1006,
    },
    {
      time: '2026-07-07T11:00:00+08:00',
      tempC: 29,
      icon: '101',
      text: '多云',
      precipMm: 0,
      pop: 10,
      humidity: 55,
      windScale: '3',
      windDir: '东南风',
      pressure: 1005,
    },
  ],
}

;(globalThis as unknown as { window: Window }).window.swarm = {
  weather: {
    getConfig: vi.fn().mockResolvedValue(config),
    getForecast: vi.fn().mockResolvedValue({ ok: true, forecast }),
    onForecast: vi.fn(() => () => {}),
  },
} as unknown as Window['swarm']
Object.defineProperty(navigator, 'geolocation', {
  configurable: true,
  value: {
    getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => {
      error({ code: 2, message: 'unavailable' } as GeolocationPositionError)
    },
  },
})

afterEach(cleanup)

describe('weather card + drawer integration (real shared store)', () => {
  it('drawer/detail read the same forecast the strip fetched', async () => {
    const { WeatherCard } = await import('./weather-card')
    render(<WeatherCard />)

    // Strip loads from the real store.
    expect(await screen.findByText('28°')).toBeInTheDocument()

    // Opening the drawer must show the SAME forecast — not an independent,
    // still-empty state instance.
    fireEvent.click(screen.getByRole('button', { name: /北京市/ }))
    expect(await screen.findByText(/体感 31°/)).toBeInTheDocument()
    expect(screen.getByText(/能见度/)).toBeInTheDocument()
    expect(screen.getByText(/16km/)).toBeInTheDocument()
  })
})
