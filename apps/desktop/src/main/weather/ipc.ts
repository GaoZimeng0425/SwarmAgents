// Wires the weather service to Electron IPC. Exposes getConfig/setConfig/
// getForecast handlers and broadcasts fresh forecasts to all renderer windows
// (the dashboard card subscribes so it updates without polling). Config changes
// are read on demand (the hook re-queries), so no push channel is needed there.
import { createLogger } from '@shared/logger'
import type { MainMethod, WeatherConfig } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'weather-ipc' })

const FORECAST_CHANNEL = 'weather:forecastChanged'

// Forecast result shape crossing the service→main RPC boundary. Mirrors the
// renderer-facing ipc handler result so both paths share one error mapping.
export type ForecastRpcResult =
  | { ok: true; forecast: Awaited<ReturnType<Service['getForecast']>> }
  | { ok: false; code: 'not_configured' | 'locate_failed' | 'fetch_failed'; message: string }

// Shared core: resolves + caches a forecast and maps errors to the result union.
// `broadcast` pushes the fresh forecast to renderer windows (renderer ipc path)
// but is skipped for the service→main RPC path (no renderer is watching).
function resolveForecast(
  service: Service,
  lng: number | null,
  lat: number | null,
  broadcast: boolean
): Promise<ForecastRpcResult> {
  return service
    .getForecast(lng, lat)
    .then((forecast) => {
      if (broadcast) {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send(FORECAST_CHANNEL, forecast)
        }
      }
      return { ok: true as const, forecast }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      // Map to the WeatherForecastResult.code union. geo.ts throws messages
      // like "ip-api HTTP …", "ip-api returned no coordinates", or
      // "QWeather GeoAPI …" — all locate failures. The service throws the
      // literal "not configured" sentinel before any locate attempt.
      const lower = message.toLowerCase()
      const isLocate =
        lower.includes('ip-api') ||
        lower.includes('coordinates') ||
        lower.includes('geoapi') ||
        lower.includes('locate')
      const code = message === 'not configured' ? 'not_configured' : isLocate ? 'locate_failed' : 'fetch_failed'
      return { ok: false as const, code, message }
    })
}

export type RpcHandlers = Partial<Record<MainMethod, (...args: unknown[]) => Promise<unknown>>>

export function wireWeatherIpc(args: { service: Service }): {
  dispose: () => void
  rpcHandlers: RpcHandlers
} {
  const { service } = args

  ipcMain.handle('weather:getConfig', () => service.getConfig())

  ipcMain.handle('weather:setConfig', (_e: Electron.IpcMainInvokeEvent, c: unknown) => {
    if (typeof c !== 'object' || c === null) {
      return { ok: false, code: 'invalid', message: 'config must be an object' }
    }
    return service.setConfig(c as WeatherConfig)
  })

  ipcMain.handle('weather:getForecast', (_e: Electron.IpcMainInvokeEvent, lng: unknown, lat: unknown) => {
    const l = typeof lng === 'number' ? lng : null
    const la = typeof lat === 'number' ? lat : null
    return resolveForecast(service, l, la, true)
  })

  // Service→main RPC: the weather tool calls this to reuse the same QWeather
  // service (same config, cache, location priority) the dashboard card uses.
  // No GPS coords (the service worker has none) → service falls back to
  // saved location > IP, exactly like a dashboard fetch without a GPS fix.
  const rpcHandlers: RpcHandlers = {
    'weather.get_forecast': (lng, lat) => {
      const l = typeof lng === 'number' ? lng : null
      const la = typeof lat === 'number' ? lat : null
      return resolveForecast(service, l, la, false)
    },
  }

  log.info({ msg: 'weather IPC wired' })

  return {
    dispose(): void {
      ipcMain.removeHandler('weather:getConfig')
      ipcMain.removeHandler('weather:setConfig')
      ipcMain.removeHandler('weather:getForecast')
    },
    rpcHandlers,
  }
}
