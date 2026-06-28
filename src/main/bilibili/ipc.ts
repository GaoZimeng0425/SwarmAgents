// src/main/bilibili/ipc.ts
//
// Wires the Bilibili subsystem to Electron IPC: login/logout/status and a single
// aggregated list endpoint. buildList is exported for unit testing.
import { createLogger } from '@shared/logger'
import type { BiliCredentials, BiliListResult, BiliVideo, BiliFavFolder } from '@shared/types/bilibili'
import { ipcMain } from 'electron'

import { getFavFolders, getFavResources, getWatchLater } from './api'
import type { Auth } from './auth'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-ipc' })

export type ListDeps = {
  getFavFolders: (c: BiliCredentials, mid: number) => Promise<BiliFavFolder[]>
  getFavResources: (c: BiliCredentials, mediaId: number, folderTitle: string) => Promise<BiliVideo[]>
  getWatchLater: (c: BiliCredentials) => Promise<BiliVideo[]>
}

export async function buildList(c: BiliCredentials, mid: number, deps: ListDeps): Promise<BiliListResult> {
  const folders = await deps.getFavFolders(c, mid)
  const withVideos = await Promise.all(
    folders.map(async (folder) => {
      try {
        const videos = await deps.getFavResources(c, folder.id, folder.title)
        return { folder, videos }
      } catch (err) {
        log.warn({ msg: 'fav folder load failed', folderId: folder.id, err: err instanceof Error ? err.message : String(err) })
        return { folder, videos: [] as BiliVideo[] }
      }
    })
  )
  let watchLater: BiliVideo[] = []
  try {
    watchLater = await deps.getWatchLater(c)
  } catch (err) {
    log.warn({ msg: 'watch-later load failed', err: err instanceof Error ? err.message : String(err) })
  }
  return { folders: withVideos, watchLater }
}

export function wireBilibiliIpc(opts: { auth: Auth; store: Store }): { dispose: () => void } {
  const { auth, store } = opts
  const deps: ListDeps = { getFavFolders, getFavResources, getWatchLater }

  ipcMain.handle('bilibili:status', () => auth.status())
  ipcMain.handle('bilibili:login', () => auth.login())
  ipcMain.handle('bilibili:logout', () => auth.logout())
  ipcMain.handle('bilibili:list', async (): Promise<BiliListResult> => {
    const started = Date.now()
    const st = await auth.status()
    if (!st.loggedIn || st.mid === null) {
      log.warn({ msg: 'bilibili:list called while logged out' })
      return { folders: [], watchLater: [] }
    }
    const cfg = await store.load()
    if (!cfg.credentials) {
      log.warn({ msg: 'bilibili:list logged-in but no stored credentials', mid: st.mid })
      return { folders: [], watchLater: [] }
    }
    log.info({ msg: 'bilibili list started', mid: st.mid })
    const result = await buildList(cfg.credentials, st.mid, deps)
    log.info({
      msg: 'bilibili list ok',
      folders: result.folders.length,
      watchLater: result.watchLater.length,
      durationMs: Date.now() - started,
    })
    return result
  })

  log.info({ msg: 'bilibili IPC wired' })
  return {
    dispose(): void {
      for (const ch of ['bilibili:status', 'bilibili:login', 'bilibili:logout', 'bilibili:list']) {
        ipcMain.removeHandler(ch)
      }
    },
  }
}
