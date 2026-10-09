// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openSettings = vi.fn()
vi.mock('@/hooks/use-settings-nav', () => ({ useSettingsNav: () => ({ openSettings }) }))

let mockState: any
vi.mock('@/hooks/use-weather', () => ({ useWeather: () => mockState }))

const readyForecast = {
  location: '北京市 · 朝阳区',
  lng: 116.4,
  lat: 39.9,
  source: 'gps' as const,
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

afterEach(cleanup)
beforeEach(() => {
  openSettings.mockClear()
})

describe('WeatherCard', () => {
  it('not-configured: click goes to settings, no drawer', async () => {
    mockState = {
      config: { projectId: '', credentialId: '', hasPrivateKey: false },
      forecast: null,
      status: 'idle',
      error: null,
      refresh: vi.fn(),
      clear: vi.fn(),
    }
    const { WeatherCard } = await import('./weather-card')
    render(<WeatherCard />)
    fireEvent.click(screen.getByText(/配置和风天气/))
    expect(openSettings).toHaveBeenCalledWith('weather')
  })

  it('ready: shows temp + opens drawer on click', async () => {
    mockState = {
      config: { projectId: 'p', credentialId: 'c', hasPrivateKey: true },
      forecast: readyForecast,
      status: 'ready',
      error: null,
      refresh: vi.fn(),
      clear: vi.fn(),
    }
    const { WeatherCard } = await import('./weather-card')
    render(<WeatherCard />)
    // Temp renders as a big number + a small muted degree glyph (two spans).
    expect(screen.getByText('28')).toBeInTheDocument()
    // Feels-like now also shows in the strip subline, so assert a drawer-unique
    // string (能见度 / visibility tile) to confirm the drawer actually opened.
    fireEvent.click(screen.getByRole('button', { name: /北京市/ }))
    expect(await screen.findByText(/能见度/)).toBeInTheDocument()
  })
})
