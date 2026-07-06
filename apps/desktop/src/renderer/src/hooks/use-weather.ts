// Subscribes to the QWeather config + forecast from main. Mirrors use-web-search,
// extended with forecast state (status machine: idle/locating/fetching/ready/error)
// and a refresh() that runs geolocation in the renderer before asking main for data.
//
// State lives in a module-level zustand store (not per-component useState) so the
// dashboard strip, the drawer and the detail body all read the SAME forecast: the
// strip is the sole fetch owner, but the drawer/detail must see what it fetched
// even though they mount later than the `weather:forecastChanged` push.
import { useEffect } from 'react'
import type { WeatherConfigView, WeatherForecast } from '@swarm/protocol'
import { create } from 'zustand'

type Status = 'idle' | 'locating' | 'fetching' | 'ready' | 'error'

// Redacted read projection: no privateKeyPem (the PEM never crosses IPC on read).
const DEFAULT_CONFIG: WeatherConfigView = {
  host: 'https://devapi.qweather.com',
  projectId: '',
  credentialId: '',
  hasPrivateKey: false,
  location: '',
}

export type UseWeather = {
  config: WeatherConfigView
  forecast: WeatherForecast | null
  status: Status
  error: string | null
  /** Run geolocation (gps -> ip fallback) then fetch the forecast. */
  refresh(): Promise<void>
  /** Forget the current forecast (e.g. when leaving the dashboard). */
  clear(): void
}

type WeatherStore = UseWeather & {
  /** Reloads config from main. Not part of the public UseWeather shape. */
  _loadConfig(): Promise<void>
}

export const useWeatherStore = create<WeatherStore>()((set) => ({
  config: DEFAULT_CONFIG,
  forecast: null,
  status: 'idle',
  error: null,

  refresh: async (): Promise<void> => {
    set({ status: 'locating', error: null })

    // Renderer-side geolocation (OS permission prompt). On any failure, fall
    // through to IP fallback by passing null coords to main.
    let lng: number | null = null
    let lat: number | null = null
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            timeout: 8_000,
            maximumAge: 5 * 60_000,
          })
        })
        lng = pos.coords.longitude
        lat = pos.coords.latitude
      } catch {
        // Silent: fall back to IP. The card shows the resulting source badge.
      }
    }

    set({ status: 'fetching' })
    const r = await window.swarm.weather.getForecast(lng, lat)
    if (r.ok) {
      // The push handler will also fire; setting here is harmless and covers
      // the case where the push ordering is delayed.
      set({ forecast: r.forecast, status: 'ready' })
    } else {
      set({ error: r.message, status: 'error' })
    }
  },

  clear: (): void => {
    set({ forecast: null, status: 'idle', error: null })
  },

  _loadConfig: async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.swarm?.weather) return
    const config = await window.swarm.weather.getConfig()
    set({ config })
  },
}))

// The forecast push listener is global state, not per-component: bind it once
// no matter how many components call useWeather().
let bound = false
function bindForecastListener(): void {
  if (bound) return
  if (typeof window === 'undefined' || !window.swarm?.weather) return
  bound = true
  window.swarm.weather.onForecast((forecast) => {
    useWeatherStore.setState({ forecast, status: 'ready', error: null })
  })
}

export function useWeather(): UseWeather {
  // Bind the push listener once globally, and reload config on every mount so
  // reopening Settings (which writes config via a different call) is reflected.
  useEffect(() => {
    bindForecastListener()
    void useWeatherStore.getState()._loadConfig()
  }, [])

  const { config, forecast, status, error, refresh, clear } = useWeatherStore()
  return { config, forecast, status, error, refresh, clear }
}
