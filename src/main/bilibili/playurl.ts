// Picks a video's DASH audio-only stream URL for local ASR. Mirrors subtitle.ts:
// cid from the view endpoint, WBI-signed playurl (fnval=16 requests DASH). We
// choose the lowest-bandwidth audio track — ASR gains nothing from high bitrate,
// and a smaller file downloads and transcodes faster.
import { createLogger } from '@shared/logger'
import type { BiliCredentials } from '@shared/types/bilibili'

import { get, getCid, getWbiKeys, toHttpsUrl } from './api'
import type { SubtitleDeps } from './subtitle'
import { encWbi } from './wbi'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-playurl' })

export type PlayUrlDeps = SubtitleDeps

export const defaultPlayUrlDeps: PlayUrlDeps = {
  getWbiKeys,
  getCid,
  nowSec: () => Math.round(Date.now() / 1000),
}

type DashAudio = { id: number; baseUrl: string; bandwidth: number }
type PlayUrlData = { dash?: { audio?: DashAudio[] } }

export async function getDashAudioUrl(deps: PlayUrlDeps, c: BiliCredentials, bvid: string): Promise<string> {
  log.info({ msg: 'playurl started', bvid })
  const cid = await deps.getCid(c, bvid)
  const { imgKey, subKey } = await deps.getWbiKeys(c)
  const query = encWbi({ bvid, cid, fnval: 16, fourk: 1 }, imgKey, subKey, deps.nowSec())

  const data = await get<PlayUrlData>(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, c)
  const audios = data.dash?.audio ?? []
  if (audios.length === 0) {
    log.warn({ msg: 'playurl no dash audio', bvid })
    throw new Error(`no dash audio for ${bvid}`)
  }
  const chosen = audios.reduce((lo, a) => (a.bandwidth < lo.bandwidth ? a : lo))
  log.info({ msg: 'playurl ok', bvid, bandwidth: chosen.bandwidth })
  return toHttpsUrl(chosen.baseUrl)
}
