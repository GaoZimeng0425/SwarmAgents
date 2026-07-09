// Weather config + forecast for the dashboard. The forecast is a React Query
// query (the app's standard data layer): staleTime gives the cache — re-entering
// the dashboard reuses a fresh forecast instead of re-fetching, gcTime keeps it
// across unmounts, and refetchOnWindowFocus replaces the old manual visibility
// refresh. React Query's global cache is also what lets the strip, drawer, and
// detail share ONE forecast without a bespoke store.
//
// The config stays in a tiny zustand store: it is loaded from main on mount and
// re-read when Settings writes it, which is a different lifecycle from the
// cached forecast.
import { useEffect } from 'react'
import type { WeatherConfigView, WeatherForecast } from '@swarm/protocol'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'

// Forecast freshness window. Mirrors the main-process cache TTL (weather service
// CACHE_TTL_MS): within this age the cached forecast is served as-is, so no
// geolocation prompt / IPC round-trip / skeleton on every dashboard visit.
const FORECAST_TTL_MS = 30 * 60 * 1000
const FORECAST_KEY = ['weather', 'forecast'] as const

type Status = 'idle' | 'fetching' | 'ready' | 'error'

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
  /** Force a fetch now (geolocation → forecast), bypassing the cache. */
  refresh(): Promise<void>
  /** Drop the cached forecast (e.g. on sign-out / reconfigure). */
  clear(): void
}

// Config-only store; the forecast lives in the React Query cache.
type ConfigStore = { config: WeatherConfigView; loadConfig(): Promise<void> }
const useConfigStore = create<ConfigStore>()((set) => ({
  config: DEFAULT_CONFIG,
  loadConfig: async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.swarm?.weather) return
    set({ config: await window.swarm.weather.getConfig() })
  },
}))

// Renderer-side geolocation (OS prompt) then the IPC forecast fetch. Any
// geolocation failure falls through to main's IP fallback (null coords). Throws
// on fetch failure so React Query surfaces it as query.error.
async function fetchForecast(): Promise<WeatherForecast> {
  let lng: number | null = null
  let lat: number | null = null
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8_000, maximumAge: 5 * 60_000 })
      })
      lng = pos.coords.longitude
      lat = pos.coords.latitude
    } catch {
      // Silent: fall back to IP. The card shows the resulting source badge.
    }
  }
  const r = await window.swarm.weather.getForecast(lng, lat)
  if (!r.ok) throw new Error(r.message)
  return r.forecast
}

// Bind the main→renderer forecast push once: main recomputes on config change
// (and the drawer's refresh runs through the same query), so writing the pushed
// forecast straight into the cache keeps every subscriber in sync.
let bound = false
function bindForecastListener(qc: QueryClient): void {
  if (bound) return
  if (typeof window === 'undefined' || !window.swarm?.weather) return
  bound = true
  window.swarm.weather.onForecast((forecast) => qc.setQueryData(FORECAST_KEY, forecast))
}

export function useWeather(): UseWeather {
  const qc = useQueryClient()
  const config = useConfigStore((s) => s.config)

  // Bind the push listener once and reload config on every mount so reopening
  // Settings (which writes config via a different call) is reflected.
  useEffect(() => {
    bindForecastListener(qc)
    void useConfigStore.getState().loadConfig()
  }, [qc])

  const configured = !!config.projectId && !!config.credentialId && config.hasPrivateKey

  const query = useQuery({
    queryKey: FORECAST_KEY,
    queryFn: fetchForecast,
    enabled: configured,
    staleTime: FORECAST_TTL_MS,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: true,
    // Poll every 30 min so the dashboard reading (and its "N ago" label) stays
    // current without a user action. Matches FORECAST_TTL_MS / the main cache TTL.
    refetchInterval: FORECAST_TTL_MS,
    retry: 1,
  })

  const status: Status = query.isFetching ? 'fetching' : query.isError ? 'error' : query.data ? 'ready' : 'idle'

  return {
    config,
    forecast: query.data ?? null,
    status,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async (): Promise<void> => {
      await query.refetch()
    },
    clear: (): void => {
      qc.removeQueries({ queryKey: FORECAST_KEY })
    },
  }
}
