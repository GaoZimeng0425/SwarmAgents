// src/main/bilibili/ipc.ts
//
// Wires the Bilibili subsystem to Electron IPC: login/logout/status and a single
// aggregated list endpoint. buildList is exported for unit testing.
import { createLogger } from '@shared/logger'
import type { BiliCredentials, BiliListResult, BiliProcessResult, BiliVideo, BiliFavFolder } from '@shared/types/bilibili'
import type { ProviderInjection } from '@shared/types/provider'
import { ipcMain } from 'electron'

import { getFavFolders, getFavResources, getWatchLater } from './api'
import type { Auth } from './auth'
import { processVideo } from './pipeline'
import type { Store } from './store'
import { getSubtitleText, defaultSubtitleDeps } from './subtitle'
import { summarize } from './summarize'

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

export function wireBilibiliIpc(opts: {
  auth: Auth
  store: Store
  getInjection: () => ProviderInjection | null
}): { dispose: () => void } {
  const { auth, store } = opts
  const deps: ListDeps = { getFavFolders, getFavResources, getWatchLater }

  // Populated when bilibili:list resolves so pipeline can look up title/author without refetch.
  const metaIndex = new Map<string, { title: string; author: string }>()

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
    // Refresh metaIndex so bilibili:process has title/author without a refetch.
    metaIndex.clear()
    for (const { videos } of result.folders) {
      for (const v of videos) {
        metaIndex.set(v.bvid, { title: v.title, author: v.author })
      }
    }
    for (const v of result.watchLater) {
      metaIndex.set(v.bvid, { title: v.title, author: v.author })
    }
    return result
  })

  // Single-flight map: concurrent requests for the same bvid join the in-flight Promise.
  const inflight = new Map<string, Promise<BiliProcessResult>>()

  ipcMain.handle('bilibili:process', async (_e, bvid: string): Promise<BiliProcessResult> => {
    const existing = inflight.get(bvid)
    if (existing) {
      log.warn({ msg: 'process already inflight; joining', bvid })
      return existing
    }
    const run = (async (): Promise<BiliProcessResult> => {
      const st = await auth.status()
      const cfg = await store.load()
      if (!st.loggedIn || !cfg.credentials) return { ok: false, code: 'unknown', message: '未登录' }
      return processVideo(
        {
          getInjection: opts.getInjection,
          getMeta: (id) => metaIndex.get(id) ?? null,
          getSubtitleText: (c, id) => getSubtitleText(defaultSubtitleDeps, c, id),
          summarize,
        },
        cfg.credentials,
        bvid
      )
    })()
    inflight.set(bvid, run)
    try {
      return await run
    } finally {
      inflight.delete(bvid)
    }
  })

  log.info({ msg: 'bilibili IPC wired' })
  return {
    dispose(): void {
      for (const ch of ['bilibili:status', 'bilibili:login', 'bilibili:logout', 'bilibili:list', 'bilibili:process']) {
        ipcMain.removeHandler(ch)
      }
    },
  }
}
