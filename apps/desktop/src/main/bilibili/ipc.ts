// src/main/bilibili/ipc.ts
//
// Wires the Bilibili subsystem to Electron IPC: login/logout/status, an aggregated list
// endpoint, video processing/open, Obsidian config/save, deletion (with local
// archive), and pins. buildList is exported for unit testing.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type {
  AnalyzeBilibiliRequest,
  AnalyzeBilibiliResult,
  BiliAnalysis,
  BiliAnalysisSource,
  BiliCredentials,
  BiliDeleteResult,
  BiliFavFolder,
  BiliListResult,
  BiliProcessResult,
  BiliSaveResult,
  BiliSummary,
  BiliTranscribeProgress,
  BiliTranscribeResult,
  BiliVideo,
  ObsidianConfig,
  ProviderInjection,
  TranscriptionConfig,
} from '@swarm/protocol'
import { TranscriptionConfigSchema } from '@swarm/protocol'
import { app, dialog, shell } from 'electron'

import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import type { AnalysisStore } from './analysis-store'
import { deleteFavResource, deleteWatchLater, getFavFolders, getFavResources, getWatchLater } from './api'
import type { ArchiveStore } from './archive-store'
import { defaultAudioDeps, extractWav } from './audio'
import type { Auth } from './auth'
import { writeNote } from './obsidian'
import type { PinStore } from './pin-store'
import { processVideo } from './pipeline'
import { defaultPlayUrlDeps, getDashAudioUrl } from './playurl'
import type { Store } from './store'
import { defaultSubtitleDeps, getSubtitleText } from './subtitle'
import { transcribeWav } from './transcribe'
import { createTranscribeQueue } from './transcribe-queue'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-ipc' })

// Opens a video in the default browser. The official desktop app's `bilipc://`
// deep link was tried first historically, but its client-side handler silently
// dropped the navigation (verified via the app's own log: it receives the URL
// but never opens a player window), so the web URL is now the only path.
// `openExternal` is injected so this is unit-testable without Electron's shell.
export async function openVideo(bvid: string, openExternal: (url: string) => Promise<void>): Promise<void> {
  const webUrl = `https://www.bilibili.com/video/${bvid}`
  await openExternal(webUrl)
  log.info({ msg: 'opened video in browser', bvid })
}

export type ListDeps = {
  getFavFolders: (c: BiliCredentials, mid: number) => Promise<BiliFavFolder[]>
  getFavResources: (c: BiliCredentials, mediaId: number, folderTitle: string) => Promise<BiliVideo[]>
  getWatchLater: (c: BiliCredentials) => Promise<BiliVideo[]>
}

export type BuildListResult = BiliListResult & {
  /** How many fav folders failed to load (swallowed into empty videos). */
  failedFolders: number
  /** Whether the watch-later fetch threw. */
  failedWatchLater: boolean
}

export async function buildList(c: BiliCredentials, mid: number, deps: ListDeps): Promise<BuildListResult> {
  const folders = await deps.getFavFolders(c, mid)
  let failedFolders = 0
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
        failedFolders++
        return { folder, videos: [] as BiliVideo[] }
      }
    })
  )
  let watchLater: BiliVideo[] = []
  let failedWatchLater = false
  try {
    watchLater = await deps.getWatchLater(c)
  } catch (err) {
    log.warn({ msg: 'watch-later load failed', err: err instanceof Error ? err.message : String(err) })
    failedWatchLater = true
  }
  return { folders: withVideos, watchLater, failedFolders, failedWatchLater }
}

export function wireBilibiliIpc(opts: {
  auth: Auth
  store: Store
  analysisStore: AnalysisStore
  archiveStore: ArchiveStore
  pinStore: PinStore
  getInjection: () => ProviderInjection | null
  analyzeBilibili: (req: AnalyzeBilibiliRequest) => Promise<AnalyzeBilibiliResult>
}): {
  dispose: () => void
} {
  const { auth, store, analysisStore, archiveStore, pinStore } = opts
  const deps: ListDeps = { getFavFolders, getFavResources, getWatchLater }
  const ipc = createIpcRegistrar()

  // Trigger the service-process bilibili-analyst agent. Returns a sync ack —
  // the structured BiliSummary streams back via bilibili.analysis* events and
  // persists via the service's onComplete (bilibili.save_analysis RPC). This
  // adapter only surfaces preflight failures (no_provider / no_agent); the LLM
  // outcome arrives asynchronously.
  const triggerAnalyze = async (
    inj: ProviderInjection,
    input: { bvid: string; title: string; author: string; text: string; source: BiliAnalysisSource }
  ): Promise<void> => {
    const result = await opts.analyzeBilibili({ ...input, provider: inj })
    if (!result.ok) throw new Error(result.message)
  }

  // Populated when bilibili:list resolves so pipeline can look up title/author without refetch.
  const metaIndex = new Map<string, { title: string; author: string }>()

  // Transcription work directory + serial queue. Progress is broadcast to all
  // renderer windows so the detail panel can show the current stage.
  const workDir = join(app.getPath('temp'), 'swarm-bili-asr')

  const broadcast = (p: BiliTranscribeProgress): void => {
    sendToAllWindows('bilibili:transcribe:progress', p)
  }

  const queue = createTranscribeQueue({
    getCredentials: async () => (await store.load()).credentials,
    getConfig: async () => (await store.load()).transcription,
    getInjection: opts.getInjection,
    getMeta: (id) => metaIndex.get(id) ?? null,
    getDashAudioUrl: (c, id) => getDashAudioUrl(defaultPlayUrlDeps, c, id),
    extractWav: (a) => extractWav(defaultAudioDeps, a),
    transcribeWav,
    triggerAnalyze,
    workDir,
    cleanup: (wav) => fs.rm(wav, { force: true }),
  })
  queue.onProgress(broadcast)

  ipc.handle('bilibili:status', async () => {
    const st = await auth.status()
    log.info({ msg: 'status handler returned', loggedIn: st.loggedIn, mid: st.mid, uname: st.uname })
    return st
  })
  ipc.handle('bilibili:login', () => auth.login())
  ipc.handle('bilibili:logout', () => auth.logout())
  ipc.handle('bilibili:list', async (): Promise<BiliListResult> => {
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
    // Distinguish "genuinely empty" from "every fetch failed". When every fav
    // folder failed AND watch-later also failed/empty, throw so the renderer's
    // listQuery surfaces "加载失败 + 重试" instead of a misleading "暂无视频".
    // Partial failures still degrade gracefully (failed folders show empty).
    const allFoldersFailed = result.folders.length > 0 && result.failedFolders === result.folders.length
    const noWatchLater = result.failedWatchLater || result.watchLater.length === 0
    if (allFoldersFailed && noWatchLater) {
      log.error({
        msg: 'bilibili list all sources failed',
        folders: result.folders.length,
        failedFolders: result.failedFolders,
        failedWatchLater: result.failedWatchLater,
        durationMs: Date.now() - started,
      })
      throw new Error('收藏列表加载失败,可能是 B 站风控,请稍后重试。')
    }
    log.info({
      msg: 'bilibili list ok',
      folders: result.folders.length,
      watchLater: result.watchLater.length,
      failedFolders: result.failedFolders,
      failedWatchLater: result.failedWatchLater,
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

  ipc.handle('bilibili:process', async (_e, bvid: string): Promise<BiliProcessResult> => {
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
          triggerAnalyze,
        },
        cfg.credentials,
        bvid
      )
      return result
    })()
    inflight.set(bvid, run)
    try {
      return await run
    } finally {
      inflight.delete(bvid)
    }
  })

  ipc.handle('bilibili:open', (_e, bvid: string) => openVideo(bvid, (url) => shell.openExternal(url)))

  ipc.handle('bilibili:getObsidianConfig', async (): Promise<ObsidianConfig | null> => {
    return (await store.load()).obsidian ?? null
  })

  ipc.handle('bilibili:setObsidianConfig', async (_e, cfg: ObsidianConfig): Promise<void> => {
    const current = await store.load()
    await store.save({ ...current, obsidian: cfg })
    log.info({ msg: 'obsidian config saved', vaultPath: cfg.vaultPath, subdir: cfg.subdir })
  })

  ipc.handle('bilibili:pickVault', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipc.handle('bilibili:save', async (_e, video: BiliVideo, summary: BiliSummary): Promise<BiliSaveResult> => {
    const cfg = (await store.load()).obsidian ?? null
    return writeNote(cfg, video, summary, new Date().toISOString().slice(0, 10))
  })

  ipc.handle('bilibili:getTranscribeConfig', async (): Promise<TranscriptionConfig | null> => {
    return (await store.load()).transcription ?? null
  })

  ipc.handle('bilibili:setTranscribeConfig', async (_e, cfg: TranscriptionConfig): Promise<void> => {
    // Validate the renderer-supplied shape before persisting; ffmpegPath later
    // reaches child_process.spawn, so it must not be trusted blindly.
    const checked = TranscriptionConfigSchema.parse(cfg)
    const current = await store.load()
    await store.save({ ...current, transcription: checked })
    log.info({ msg: 'transcribe config saved', ffmpegPath: checked.ffmpegPath, modelDir: checked.modelDir })
  })

  ipc.handle('bilibili:pickModelDir', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipc.handle('bilibili:transcribe', async (_e, bvid: string): Promise<BiliTranscribeResult> => {
    try {
      await fs.mkdir(workDir, { recursive: true })
    } catch (err) {
      log.error({
        msg: 'transcribe workdir create failed',
        bvid,
        err: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, code: 'unknown', message: '无法创建临时目录。' }
    }
    log.info({ msg: 'transcribe requested', bvid })
    const result = await queue.enqueue(bvid)
    return result
  })

  ipc.handle('bilibili:analyzedBvids', (): string[] => analysisStore.bvids())

  ipc.handle('bilibili:getAnalysis', (_e, bvid: string): BiliAnalysis | null => analysisStore.get(bvid))

  // Remove a video from Bilibili's watch-later list. Returns a result envelope
  // (not a throw) so the renderer can surface failures inline. Archiving the
  // card locally is the renderer's concern — it calls archivePut separately.
  ipc.handle('bilibili:deleteWatchLater', async (_e, bvid: string): Promise<BiliDeleteResult> => {
    const started = Date.now()
    const cfg = await store.load()
    if (!cfg.credentials) {
      log.warn({ msg: 'deleteWatchLater called while logged out', bvid })
      return { ok: false, code: 'not_logged_in', message: '未登录' }
    }
    try {
      await deleteWatchLater(cfg.credentials, bvid)
      log.info({ msg: 'watch-later deleted', bvid, durationMs: Date.now() - started })
      return { ok: true }
    } catch (err) {
      log.error({ msg: 'watch-later delete failed', bvid, err: err instanceof Error ? err.message : String(err) })
      return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // Remove a favorites video from Bilibili. Needs the fav* ids (oid:type scoped
  // to media_id) carried on the BiliVideo — the renderer passes the whole video.
  ipc.handle('bilibili:deleteFav', async (_e, video: BiliVideo): Promise<BiliDeleteResult> => {
    const started = Date.now()
    const cfg = await store.load()
    if (!cfg.credentials) {
      log.warn({ msg: 'deleteFav called while logged out', bvid: video.bvid })
      return { ok: false, code: 'not_logged_in', message: '未登录' }
    }
    if (video.favMediaId === undefined || video.favOid === undefined || video.favType === undefined) {
      log.error({ msg: 'deleteFav missing fav ids', bvid: video.bvid })
      return { ok: false, code: 'unknown', message: '缺少收藏夹资源信息' }
    }
    try {
      await deleteFavResource(cfg.credentials, video.favMediaId, video.favOid, video.favType)
      log.info({ msg: 'fav deleted', bvid: video.bvid, durationMs: Date.now() - started })
      return { ok: true }
    } catch (err) {
      log.error({ msg: 'fav delete failed', bvid: video.bvid, err: err instanceof Error ? err.message : String(err) })
      return { ok: false, code: 'unknown', message: err instanceof Error ? err.message : String(err) }
    }
  })

  // Local archive: a "soft delete" keeps the video card locally. Pure local
  // state — no credentials, no network.
  ipc.handle('bilibili:archiveList', (): BiliVideo[] => archiveStore.list())
  ipc.handle('bilibili:archivePut', (_e, video: BiliVideo): Promise<void> => {
    log.info({ msg: 'archive put', bvid: video.bvid })
    return archiveStore.put(video)
  })
  ipc.handle('bilibili:archiveRemove', (_e, bvid: string): Promise<void> => {
    log.info({ msg: 'archive remove', bvid })
    return archiveStore.remove(bvid)
  })

  // Pins: local "favorites" shown in the page's top bar. Pure local state.
  ipc.handle('bilibili:pinsList', (): BiliVideo[] => pinStore.list())
  ipc.handle('bilibili:pinsPut', (_e, video: BiliVideo): Promise<void> => {
    log.info({ msg: 'pin put', bvid: video.bvid })
    return pinStore.put(video)
  })
  ipc.handle('bilibili:pinsRemove', (_e, bvid: string): Promise<void> => {
    log.info({ msg: 'pin remove', bvid })
    return pinStore.remove(bvid)
  })

  log.info({ msg: 'bilibili IPC wired' })
  return {
    dispose(): void {
      queue.dispose()
      ipc.dispose()
    },
  }
}
