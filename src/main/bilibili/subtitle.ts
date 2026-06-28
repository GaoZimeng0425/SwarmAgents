// Fetches a video's subtitle as plain text. cid comes from the view endpoint;
// the subtitle list comes from the WBI-signed player endpoint; each entry's
// subtitle_url points at a JSON of {body:[{content}]}. Returns null when the
// video carries no subtitle (caller decides the fallback).
import { createLogger } from '@shared/logger'
import type { BiliCredentials } from '@shared/types/bilibili'

import { BILI_REFERER, BILI_UA, get, getCid, getWbiKeys, toHttpsUrl } from './api'
import { encWbi } from './wbi'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-subtitle' })

export type SubtitleDeps = {
  getWbiKeys: (c: BiliCredentials) => Promise<{ imgKey: string; subKey: string }>
  getCid: (c: BiliCredentials, bvid: string) => Promise<number>
  nowSec: () => number
}

export const defaultSubtitleDeps: SubtitleDeps = {
  getWbiKeys,
  getCid,
  nowSec: () => Math.round(Date.now() / 1000),
}

type PlayerSubtitle = { subtitle_url: string; lan: string }
type PlayerData = { subtitle: { subtitles: PlayerSubtitle[] } }

export async function getSubtitleText(deps: SubtitleDeps, c: BiliCredentials, bvid: string): Promise<string | null> {
  const cid = await deps.getCid(c, bvid)
  const { imgKey, subKey } = await deps.getWbiKeys(c)
  const query = encWbi({ bvid, cid }, imgKey, subKey, deps.nowSec())

  // Player endpoint IS a {code,data} envelope — use get<T> which handles it.
  const player = await get<PlayerData>(`https://api.bilibili.com/x/player/wbi/v2?${query}`, c)
  const subs = player.subtitle?.subtitles ?? []

  if (subs.length === 0) {
    log.warn({ msg: 'no subtitle for video', bvid })
    return null
  }

  // Prefer a Chinese track; otherwise use the first available.
  const chosen = subs.find((s) => s.lan.includes('zh')) ?? subs[0]
  const url = toHttpsUrl(chosen.subtitle_url)

  // Subtitle JSON is NOT a {code,data} envelope — fetch it directly.
  const res = await fetch(url, { headers: { 'User-Agent': BILI_UA, Referer: BILI_REFERER } })
  if (!res.ok) throw new Error(`subtitle fetch HTTP ${res.status} for ${url}`)
  const doc = (await res.json()) as { body: { content: string }[] }
  return doc.body.map((l) => l.content).join('\n')
}
