//
// Bilibili public web-API client. Injects the user's cookies plus a desktop
// UA + Referer (required to avoid -412 风控). All endpoints wrap responses as
// { code, message, data }; a non-zero code is an error.
import type { BiliCredentials, BiliFavFolder, BiliLoginStatus, BiliVideo } from '@shared/types/bilibili'
import { keyFromUrl } from './wbi'

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
  const url = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(String(mid))}`
  const data = await get<{ list: FavFolderRow[] | null }>(url, c)
  const list = data.list ?? []
  return list.map((f) => ({ id: f.id, title: f.title, count: f.media_count }))
}

type FavMediaRow = {
  bvid: string
  title: string
  cover: string
  duration: number
  intro?: string
  upper?: { name?: string }
}

export async function getFavResources(c: BiliCredentials, mediaId: number, folderTitle: string): Promise<BiliVideo[]> {
  const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(String(mediaId))}&ps=20&pn=1&platform=web`
  const data = await get<{ medias: FavMediaRow[] | null }>(url, c)
  const medias = data.medias ?? []
  return medias.map((m) => ({
    bvid: m.bvid,
    title: m.title,
    cover: toHttpsUrl(m.cover),
    author: m.upper?.name ?? '',
    durationSec: m.duration,
    intro: m.intro ?? '',
    source: folderTitle,
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
// feed the signing mixin.
export async function getWbiKeys(c: BiliCredentials): Promise<{ imgKey: string; subKey: string }> {
  const data = await get<{ wbi_img: { img_url: string; sub_url: string } }>(
    'https://api.bilibili.com/x/web-interface/nav',
    c
  )
  return { imgKey: keyFromUrl(data.wbi_img.img_url), subKey: keyFromUrl(data.wbi_img.sub_url) }
}

// Returns the first page's cid for a video, needed to call the player subtitle endpoint.
export async function getCid(c: BiliCredentials, bvid: string): Promise<number> {
  const data = await get<{ cid: number }>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    c
  )
  return data.cid
}
