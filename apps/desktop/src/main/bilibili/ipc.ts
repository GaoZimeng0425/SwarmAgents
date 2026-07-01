// src/main/bilibili/ipc.ts
//
// Wires the Bilibili subsystem to Electron IPC: login/logout/status, an aggregated list
// endpoint, video processing/open, and Obsidian config/save. buildList is exported for unit testing.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import { TranscriptionConfigSchema } from '@shared/types/bilibili'
import type {
  BiliAnalysis,
  BiliCredentials,
  BiliFavFolder,
  BiliListResult,
  BiliProcessResult,
  BiliSaveResult,
  BiliSummary,
  BiliTranscribeProgress,
  BiliTranscribeResult,
  BiliVideo,
  ObsidianConfig,
  TranscriptionConfig,
} from '@shared/types/bilibili'
import type { ProviderInjection } from '@shared/types/provider'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

import { writeNote } from './obsidian'

import type { AnalysisStore } from './analysis-store'
import { getFavFolders, getFavResources, getWatchLater } from './api'
import { defaultAudioDeps, extractWav } from './audio'
import type { Auth } from './auth'
import { processVideo } from './pipeline'
import { defaultPlayUrlDeps, getDashAudioUrl } from './playurl'
import type { Store } from './store'
import { defaultSubtitleDeps, getSubtitleText } from './subtitle'
import { summarize } from './summarize'
import { transcribeWav } from './transcribe'
import { createTranscribeQueue } from './transcribe-queue'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-ipc' })

// Broadcast channel for transcription stage updates (main -> all renderers).
export const TRANSCRIBE_PROGRESS_CHANNEL = 'bilibili:transcribe:progress'

// Opens a video in the local Bilibili desktop app via its `bilipc:` URL scheme,
// falling back to the web page in the browser when the app isn't installed (the
// scheme has no handler, so openExternal rejects). `openExternal` is injected so
// the fallback logic is unit-testable without Electron's shell.
export async function openVideo(bvid: string, openExternal: (url: string) => Promise<void>): Promise<void> {
  const appUrl = `bilipc://video/${bvid}`
  const webUrl = `https://www.bilibili.com/video/${bvid}`
  try {
    await openExternal(appUrl)
    log.info({ msg: 'opened video in app', bvid })
  } catch (err) {
    log.warn({
      msg: 'app open failed; falling back to browser',
      bvid,
      err: err instanceof Error ? err.message : String(err),
    })
    await openExternal(webUrl)
  }
}

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
        log.warn({
          msg: 'fav folder load failed',
          folderId: folder.id,
          err: err instanceof Error ? err.message : String(err),
        })
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
  analysisStore: AnalysisStore
  getInjection: () => ProviderInjection | null
}): {
  dispose: () => void
} {
  const { auth, store, analysisStore } = opts
  const deps: ListDeps = { getFavFolders, getFavResources, getWatchLater }

  // Populated when bilibili:list resolves so pipeline can look up title/author without refetch.
  const metaIndex = new Map<string, { title: string; author: string }>()

  // Transcription work directory + serial queue. Progress is broadcast to all
  // renderer windows so the detail panel can show the current stage.
  const workDir = join(app.getPath('temp'), 'swarm-bili-asr')

  const broadcast = (p: BiliTranscribeProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(TRANSCRIBE_PROGRESS_CHANNEL, p)
    }
  }

  const queue = createTranscribeQueue({
    getCredentials: async () => (await store.load()).credentials,
    getConfig: async () => (await store.load()).transcription,
    getInjection: opts.getInjection,
    getMeta: (id) => metaIndex.get(id) ?? null,
    getDashAudioUrl: (c, id) => getDashAudioUrl(defaultPlayUrlDeps, c, id),
    extractWav: (a) => extractWav(defaultAudioDeps, a),
    transcribeWav,
    summarize,
    workDir,
    cleanup: (wav) => fs.rm(wav, { force: true }),
  })
  queue.onProgress(broadcast)

  // Cache a successful analysis (summary + full text) so the list can badge it and
  // the detail panel can show it instantly on reopen. A write failure must not change
  // the user-facing result, so it is logged and swallowed.
  const persistAnalysis = async (
    bvid: string,
    summary: BiliSummary,
    text: string,
    source: BiliAnalysis['source']
  ): Promise<void> => {
    try {
      await analysisStore.put({ bvid, summary, text, source, analyzedAt: new Date().toISOString() })
    } catch (err) {
      log.warn({ msg: 'analysis cache write failed', bvid, err: err instanceof Error ? err.message : String(err) })
    }
  }

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
      const result = await processVideo(
        {
          getInjection: opts.getInjection,
          getMeta: (id) => metaIndex.get(id) ?? null,
          getSubtitleText: (c, id) => getSubtitleText(defaultSubtitleDeps, c, id),
          summarize,
        },
        cfg.credentials,
        bvid
      )
      if (result.ok) await persistAnalysis(bvid, result.summary, result.text, result.source)
      return result
    })()
    inflight.set(bvid, run)
    try {
      return await run
    } finally {
      inflight.delete(bvid)
    }
  })

  ipcMain.handle('bilibili:open', (_e, bvid: string) => openVideo(bvid, (url) => shell.openExternal(url)))

  ipcMain.handle('bilibili:getObsidianConfig', async (): Promise<ObsidianConfig | null> => {
    return (await store.load()).obsidian ?? null
  })

  ipcMain.handle('bilibili:setObsidianConfig', async (_e, cfg: ObsidianConfig): Promise<void> => {
    const current = await store.load()
    await store.save({ ...current, obsidian: cfg })
    log.info({ msg: 'obsidian config saved', vaultPath: cfg.vaultPath, subdir: cfg.subdir })
  })

  ipcMain.handle('bilibili:pickVault', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('bilibili:save', async (_e, video: BiliVideo, summary: BiliSummary): Promise<BiliSaveResult> => {
    const cfg = (await store.load()).obsidian ?? null
    return writeNote(cfg, video, summary, new Date().toISOString().slice(0, 10))
  })

  ipcMain.handle('bilibili:getTranscribeConfig', async (): Promise<TranscriptionConfig | null> => {
    return (await store.load()).transcription ?? null
  })

  ipcMain.handle('bilibili:setTranscribeConfig', async (_e, cfg: TranscriptionConfig): Promise<void> => {
    // Validate the renderer-supplied shape before persisting; ffmpegPath later
    // reaches child_process.spawn, so it must not be trusted blindly.
    const checked = TranscriptionConfigSchema.parse(cfg)
    const current = await store.load()
    await store.save({ ...current, transcription: checked })
    log.info({ msg: 'transcribe config saved', ffmpegPath: checked.ffmpegPath, modelDir: checked.modelDir })
  })

  ipcMain.handle('bilibili:pickModelDir', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('bilibili:transcribe', async (_e, bvid: string): Promise<BiliTranscribeResult> => {
    try {
      await fs.mkdir(workDir, { recursive: true })
    } catch (err) {
      log.error({ msg: 'transcribe workdir create failed', bvid, err: err instanceof Error ? err.message : String(err) })
      return { ok: false, code: 'unknown', message: '无法创建临时目录。' }
    }
    log.info({ msg: 'transcribe requested', bvid })
    const result = await queue.enqueue(bvid)
    if (result.ok) await persistAnalysis(bvid, result.summary, result.text, result.source)
    return result
  })

  ipcMain.handle('bilibili:analyzedBvids', (): string[] => analysisStore.bvids())

  ipcMain.handle('bilibili:getAnalysis', (_e, bvid: string): BiliAnalysis | null => analysisStore.get(bvid))

  log.info({ msg: 'bilibili IPC wired' })
  return {
    dispose(): void {
      queue.dispose()
      for (const ch of [
        'bilibili:status',
        'bilibili:login',
        'bilibili:logout',
        'bilibili:list',
        'bilibili:process',
        'bilibili:open',
        'bilibili:getObsidianConfig',
        'bilibili:setObsidianConfig',
        'bilibili:pickVault',
        'bilibili:save',
        'bilibili:getTranscribeConfig',
        'bilibili:setTranscribeConfig',
        'bilibili:pickModelDir',
        'bilibili:transcribe',
        'bilibili:analyzedBvids',
        'bilibili:getAnalysis',
      ]) {
        ipcMain.removeHandler(ch)
      }
    },
  }
}
