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

export const ObsidianConfigSchema = z
  .object({
    vaultPath: z.string(),
    subdir: z.string(),
  })
  .strict()

export type ObsidianConfig = z.infer<typeof ObsidianConfigSchema>

export const BilibiliConfigOnDisk = z
  .object({
    credentials: BiliCredentialsSchema.nullable(),
    obsidian: ObsidianConfigSchema.nullable().default(null),
  })
  .strict()

export type BilibiliConfigOnDisk = z.infer<typeof BilibiliConfigOnDisk>

export function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk {
  return { credentials: null, obsidian: null }
}

export type BiliListResult = {
  folders: { folder: BiliFavFolder; videos: BiliVideo[] }[]
  watchLater: BiliVideo[]
}

// AI summary of a single video, parsed from the LLM's structured output.
export type BiliSummary = {
  gist: string
  points: string[]
  experience: string[]
  pitfalls: string[]
  steps: string[]
}

export type BiliProcessResult =
  | { ok: true; summary: BiliSummary }
  | { ok: false; code: 'no_subtitle' | 'no_provider' | 'llm_failed' | 'unknown'; message: string }

export type BiliSaveResult =
  | { ok: true; path: string }
  | { ok: false; code: 'no_vault' | 'write_failed'; message: string }
