// src/main/trending/ipc.ts
//
// Wires the trending subsystem to Electron IPC. Single read endpoint that
// validates params (falling back to safe defaults) and returns trending repos.
import { createLogger } from '@shared/logger'
import { TRENDING_PERIODS, type TrendingPeriod } from '@shared/types/trending'
import { ipcMain } from 'electron'

import { fetchTrending } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'trending-ipc' })

function asPeriod(v: unknown): TrendingPeriod {
  return TRENDING_PERIODS.includes(v as TrendingPeriod) ? (v as TrendingPeriod) : 'past_24_hours'
}

export function wireTrendingIpc(): { dispose: () => void } {
  ipcMain.handle('trending:get', (_e: Electron.IpcMainInvokeEvent, period: unknown, language: unknown) => {
    const p = asPeriod(period)
    const lang = typeof language === 'string' && language.length > 0 ? language : 'All'
    if (p !== period || lang !== language) {
      log.warn({
        msg: 'trending params coerced to defaults',
        period,
        language,
        resolvedPeriod: p,
        resolvedLanguage: lang,
      })
    }
    return fetchTrending(p, lang)
  })

  log.info({ msg: 'trending IPC wired' })

  return {
    dispose(): void {
      ipcMain.removeHandler('trending:get')
    },
  }
}
