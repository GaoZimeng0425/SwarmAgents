// Wires the weather service to Electron IPC. Exposes getConfig/setConfig/
// getForecast handlers and broadcasts fresh forecasts to all renderer windows
// (the dashboard card subscribes so it updates without polling). Config changes
// are read on demand (the hook re-queries), so no push channel is needed there.
import { createLogger } from '@shared/logger'
import type { WeatherConfig } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'weather-ipc' })

const FORECAST_CHANNEL = 'weather:forecastChanged'

export function wireWeatherIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args

  ipcMain.handle('weather:getConfig', () => service.getConfig())

  ipcMain.handle('weather:setConfig', (_e: Electron.IpcMainInvokeEvent, c: unknown) => {
    if (typeof c !== 'object' || c === null) {
      return { ok: false, code: 'invalid', message: 'config must be an object' }
    }
    return service.setConfig(c as WeatherConfig)
  })

  ipcMain.handle(
    'weather:getForecast',
    (_e: Electron.IpcMainInvokeEvent, lng: unknown, lat: unknown) => {
      const l = typeof lng === 'number' ? lng : null
      const la = typeof lat === 'number' ? lat : null
      return service
        .getForecast(l, la)
        .then((forecast) => {
          // Push the fresh forecast to every renderer so the dashboard card
          // updates without a re-fetch.
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(FORECAST_CHANNEL, forecast)
          }
          return { ok: true as const, forecast }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          const code = message === 'not configured' ? 'not_configured' : 'fetch_failed'
          return { ok: false as const, code, message }
        })
    },
  )

  log.info({ msg: 'weather IPC wired' })

  return {
    dispose(): void {
      ipcMain.removeHandler('weather:getConfig')
      ipcMain.removeHandler('weather:setConfig')
      ipcMain.removeHandler('weather:getForecast')
    },
  }
}
