//
// Shared types for the Bilibili integration: credentials, list items, and the
// encrypted on-disk config schema. Mirrors fields we read from Bilibili's
// public web API.
import { z } from 'zod'

export type BiliCredentials = {
  sessdata: string
  biliJct: string
  dedeUserId: string
}

// A favorites-folder or watch-later video, normalized for the UI.
export type BiliVideo = {
  bvid: string
  title: string
  cover: string
  author: string
  durationSec: number
  intro: string
  source: string
}

export type BiliFavFolder = {
  id: number
  title: string
  count: number
}

export type BiliLoginStatus = {
  loggedIn: boolean
  uname: string | null
  mid: number | null
}

export const BiliCredentialsSchema = z
  .object({
    sessdata: z.string(),
    biliJct: z.string(),
    dedeUserId: z.string(),
  })
  .strict()

export const BilibiliConfigOnDisk = z
  .object({
    credentials: BiliCredentialsSchema.nullable(),
  })
  .strict()

export type BilibiliConfigOnDisk = z.infer<typeof BilibiliConfigOnDisk>

export function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk {
  return { credentials: null }
}
