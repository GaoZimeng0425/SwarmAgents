//
// Bilibili public web-API client. Injects the user's cookies plus a desktop
// UA + Referer (required to avoid -412 风控). All endpoints wrap responses as
// { code, message, data }; a non-zero code is an error.
import type { BiliCredentials, BiliFavFolder, BiliLoginStatus, BiliVideo } from '@shared/types/bilibili'

export const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
export const BILI_REFERER = 'https://www.bilibili.com'

const TIMEOUT_MS = 10_000

export function cookieHeader(c: BiliCredentials): string {
  return `SESSDATA=${c.sessdata}; bili_jct=${c.biliJct}; DedeUserID=${c.dedeUserId}`
}

type Envelope<T> = { code: number; message?: string; data?: T }

async function get<T>(url: string, c: BiliCredentials): Promise<T> {
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
    cover: m.cover,
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
    cover: v.pic,
    author: v.owner?.name ?? '',
    durationSec: v.duration,
    intro: v.desc ?? '',
    source: '稍后再看',
  }))
}
