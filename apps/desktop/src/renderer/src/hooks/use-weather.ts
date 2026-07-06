// Subscribes to the QWeather config + forecast from main. Mirrors use-web-search,
// extended with forecast state (status machine: idle/locating/fetching/ready/error)
// and a refresh() that runs geolocation in the renderer before asking main for data.
import { useCallback, useEffect, useState } from 'react'
import type { WeatherConfigView, WeatherForecast } from '@swarm/protocol'

type Status = 'idle' | 'locating' | 'fetching' | 'ready' | 'error'

// Redacted read projection: no privateKeyPem (the PEM never crosses IPC on read).
const DEFAULT_CONFIG: WeatherConfigView = {
  host: 'https://devapi.qweather.com',
  projectId: '',
  credentialId: '',
  hasPrivateKey: false,
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

export function useWeather(): UseWeather {
  const [config, setConfig] = useState<WeatherConfigView>(DEFAULT_CONFIG)
  const [forecast, setForecast] = useState<WeatherForecast | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  // Load config once + subscribe to pushed forecasts.
  useEffect(() => {
    let cancelled = false
    void window.swarm.weather.getConfig().then((c) => {
      if (!cancelled) setConfig(c)
    })
    const offForecast = window.swarm.weather.onForecast((f) => {
      if (!cancelled) {
        setForecast(f)
        setStatus('ready')
        setError(null)
      }
    })
    return () => {
      cancelled = true
      offForecast()
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setStatus('locating')
    setError(null)

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

    setStatus('fetching')
    const r = await window.swarm.weather.getForecast(lng, lat)
    if (r.ok) {
      // The push handler will also fire; setting here is harmless and covers
      // the case where the push ordering is delayed.
      setForecast(r.forecast)
      setStatus('ready')
    } else {
      setError(r.message)
      setStatus('error')
    }
  }, [])

  const clear = useCallback((): void => {
    setForecast(null)
    setStatus('idle')
    setError(null)
  }, [])

  return { config, forecast, status, error, refresh, clear }
}
