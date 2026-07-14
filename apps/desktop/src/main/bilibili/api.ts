//
// Bilibili public web-API client. Injects the user's cookies plus a desktop
// UA + Referer (required to avoid -412 风控). All endpoints wrap responses as
// { code, message, data }; a non-zero code is an error.
import type { BiliCredentials, BiliFavFolder, BiliLoginStatus, BiliVideo } from '@swarm/protocol'

import { encWbi, keyFromUrl } from './wbi'

export const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const BILI_REFERER = 'https://www.bilibili.com'

// Bilibili returns cover/pic URLs as http:// or protocol-relative //; rewrite
// to https:// so the renderer (CSP allows only https image hosts) doesn't block
// them as mixed content.
export function toHttpsUrl(url: string): string {
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`
  if (url.startsWith('//')) return `https:${url}`
  return url
}

const TIMEOUT_MS = 10_000

export function cookieHeader(c: BiliCredentials): string {
  return `SESSDATA=${c.sessdata}; bili_jct=${c.biliJct}; DedeUserID=${c.dedeUserId}`
}

type Envelope<T> = { code: number; message?: string; data?: T }

export async function get<T>(url: string, c: BiliCredentials): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      cookie: cookieHeader(c),
      'user-agent': BILI_UA,
      referer: BILI_REFERER,
    },
  })
  if (!res.ok) throw new Error(`Bilibili HTTP ${res.status} ${res.statusText} for ${url}`)
  const body = (await res.json()) as Envelope<T>
  if (body.code !== 0) throw new Error(`Bilibili API code ${body.code}: ${body.message ?? 'unknown'}`)
  return body.data as T
}

// POST a form-encoded body. Mutation endpoints (delete fav/watch-later) require
// the csrf token (bili_jct) both as a form field and via the session cookie,
// plus UA/Referer to dodge -412 风控. Same envelope handling as get().
export async function post<T>(url: string, form: Record<string, string>, c: BiliCredentials): Promise<T> {
  const body = new URLSearchParams({ ...form, csrf: c.biliJct }).toString()
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      cookie: cookieHeader(c),
      'user-agent': BILI_UA,
      referer: BILI_REFERER,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!res.ok) throw new Error(`Bilibili HTTP ${res.status} ${res.statusText} for ${url}`)
  const json = (await res.json()) as Envelope<T>
  if (json.code !== 0) throw new Error(`Bilibili API code ${json.code}: ${json.message ?? 'unknown'}`)
  return json.data as T
}

type NavData = { isLogin?: boolean; uname?: string; mid?: number }

export async function getNav(c: BiliCredentials): Promise<BiliLoginStatus> {
  // nav returns code -101 when the cookie is invalid/expired; treat as logged-out
  // rather than throwing, so the UI can prompt re-login.
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { cookie: cookieHeader(c), 'user-agent': BILI_UA, referer: BILI_REFERER },
  })
  const body = (await res.json()) as Envelope<NavData>
  if (body.code !== 0 || !body.data?.isLogin) {
    return { loggedIn: false, uname: null, mid: null }
  }
  return { loggedIn: true, uname: body.data.uname ?? null, mid: body.data.mid ?? null }
}

type FavFolderRow = { id: number; title: string; media_count: number }

export async function getFavFolders(c: BiliCredentials, mid: number): Promise<BiliFavFolder[]> {
  const data = await getSigned<{ list: FavFolderRow[] | null }>(
    'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
    { up_mid: String(mid) },
    c
  )
  const list = data.list ?? []
  return list.map((f) => ({ id: f.id, title: f.title, count: f.media_count }))
}

type FavMediaRow = {
  id: number
  type: number
  bvid: string
  title: string
  cover: string
  duration: number
  intro?: string
  upper?: { name?: string }
}

export async function getFavResources(c: BiliCredentials, mediaId: number, folderTitle: string): Promise<BiliVideo[]> {
  const data = await getSigned<{ medias: FavMediaRow[] | null }>(
    'https://api.bilibili.com/x/v3/fav/resource/list',
    { media_id: String(mediaId), ps: '20', pn: '1', platform: 'web' },
    c
  )
  const medias = data.medias ?? []
  return medias.map((m) => ({
    bvid: m.bvid,
    title: m.title,
    cover: toHttpsUrl(m.cover),
    author: m.upper?.name ?? '',
    durationSec: m.duration,
    intro: m.intro ?? '',
    source: folderTitle,
    // Carried through so the batch-del endpoint can remove this row later:
    // resources = `<oid>:<type>` scoped to media_id.
    favMediaId: mediaId,
    favOid: m.id,
    favType: m.type,
  }))
}

type ToViewRow = {
  bvid: string
  title: string
  pic: string
  duration: number
  desc?: string
  owner?: { name?: string }
}

export async function getWatchLater(c: BiliCredentials): Promise<BiliVideo[]> {
  const data = await get<{ list: ToViewRow[] | null }>('https://api.bilibili.com/x/v2/history/toview', c)
  const list = data.list ?? []
  return list.map((v) => ({
    bvid: v.bvid,
    title: v.title,
    cover: toHttpsUrl(v.pic),
    author: v.owner?.name ?? '',
    durationSec: v.duration,
    intro: v.desc ?? '',
    source: '稍后再看',
  }))
}

// The two WBI keys live in the nav response under wbi_img; their filename stems
// feed the signing mixin. Cached for 24h: the keys are site-wide (not per-user)
// and rotate rarely (a one-off site-level operation). A signed request that
// fails (e.g. the cached keys were rotated mid-TTL) is retried once after the
// cache is invalidated — see getSigned below.
const WBI_TTL_MS = 24 * 60 * 60 * 1000
let wbiCache: { keys: { imgKey: string; subKey: string }; expiresAt: number } | null = null

export function invalidateWbiKeys(): void {
  wbiCache = null
}

export async function getWbiKeys(c: BiliCredentials): Promise<{ imgKey: string; subKey: string }> {
  if (wbiCache && Date.now() < wbiCache.expiresAt) return wbiCache.keys
  const data = await get<{ wbi_img: { img_url: string; sub_url: string } }>(
    'https://api.bilibili.com/x/web-interface/nav',
    c
  )
  const keys = { imgKey: keyFromUrl(data.wbi_img.img_url), subKey: keyFromUrl(data.wbi_img.sub_url) }
  wbiCache = { keys, expiresAt: Date.now() + WBI_TTL_MS }
  return keys
}

// Sign a WBI-protected GET and run it. If the first attempt fails (a non-zero
// code surfaces as a thrown Error — most likely the cached keys were rotated),
// invalidate the cache, re-fetch fresh keys, and retry exactly once. This keeps
// the 24h cache self-healing without the user seeing a stale-key failure.
async function getSigned<T>(baseUrl: string, params: Record<string, string>, c: BiliCredentials): Promise<T> {
  const sign = async (): Promise<string> => {
    const { imgKey, subKey } = await getWbiKeys(c)
    return encWbi(params, imgKey, subKey, Math.floor(Date.now() / 1000))
  }
  const query = await sign()
  try {
    return await get<T>(`${baseUrl}?${query}`, c)
  } catch (err) {
    // Retry once with fresh keys; if it still fails, surface the original error.
    invalidateWbiKeys()
    const retryQuery = await sign()
    return get<T>(`${baseUrl}?${retryQuery}`, c).catch(() => {
      throw err
    })
  }
}

// Returns the first page's cid for a video, needed to call the player subtitle endpoint.
export async function getCid(c: BiliCredentials, bvid: string): Promise<number> {
  const data = await get<{ cid: number }>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    c
  )
  return data.cid
}

// Remove a single video from the user's watch-later list. The toview/del
// endpoint keys on the numeric aid (passing bvid returns -400 请求错误), so
// resolve the aid from the view endpoint first.
export async function deleteWatchLater(c: BiliCredentials, bvid: string): Promise<void> {
  const { aid } = await get<{ aid: number }>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    c
  )
  await post<unknown>('https://api.bilibili.com/x/v2/history/toview/del', { aid: String(aid) }, c)
}

// Remove a single resource from a favorites folder. Bilibili's batch-del takes
// `resources` as `oid:type` (comma-separated for batches) scoped to `media_id`.
export async function deleteFavResource(c: BiliCredentials, mediaId: number, oid: number, type: number): Promise<void> {
  await post<unknown>(
    'https://api.bilibili.com/x/v3/fav/resource/batch-del',
    {
      media_id: String(mediaId),
      resources: `${oid}:${type}`,
    },
    c
  )
}
