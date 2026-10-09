// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const forecast = {
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
  ],
}

vi.mock('@/hooks/use-weather', () => ({
  useWeather: () => ({ forecast, status: 'ready', config: {}, error: null, refresh: vi.fn(), clear: vi.fn() }),
}))

afterEach(cleanup)

describe('WeatherDetail', () => {
  it('renders feels-like from now and the visibility tile', async () => {
    const { WeatherDetail } = await import('./weather-detail')
    render(<WeatherDetail />)
    expect(screen.getByText(/体感 31°/)).toBeInTheDocument()
    expect(screen.getByText(/能见度/)).toBeInTheDocument()
    expect(screen.getByText(/16km/)).toBeInTheDocument()
  })
})
