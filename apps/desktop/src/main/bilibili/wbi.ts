// WBI signing for Bilibili web endpoints that require `w_rid` (e.g. the
// player subtitle endpoint). Algorithm per bilibili-API-collect: mix the two
// nav keys through a fixed permutation table, then md5(sorted-query + mixin).
import { createHash } from 'node:crypto'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

export function getMixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] ?? '')
    .join('')
    .slice(0, 32)
}

export function keyFromUrl(url: string): string {
  const file = url.split('/').pop() ?? ''
  return file.split('.')[0] ?? ''
}

export function encWbi(params: Record<string, string | number>, imgKey: string, subKey: string, wts: number): string {
  const mixinKey = getMixinKey(imgKey + subKey)
  const withTs: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(withTs)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wrid = createHash('md5')
    .update(query + mixinKey)
    .digest('hex')
  return `${query}&w_rid=${wrid}`
}
