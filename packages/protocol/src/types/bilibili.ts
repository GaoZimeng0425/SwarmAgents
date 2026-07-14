//
// Shared types for the Bilibili integration: credentials, list items, and the
// encrypted on-disk config schema. Mirrors fields we read from Bilibili's
// public web API.

import { z } from 'zod'

import type { ProviderInjection } from './provider'

export type BiliCredentials = {
  sessdata: string
  biliJct: string
  dedeUserId: string
}

// A favorites-folder or watch-later video, normalized for the UI.
// The fav* fields are only present on favorites videos and carry the ids needed
// to delete from a fav folder via the batch-del API (resources = oid:type,
// scoped to media_id). Watch-later videos lack them.
export type BiliVideo = {
  bvid: string
  title: string
  cover: string
  author: string
  durationSec: number
  intro: string
  source: string
  favMediaId?: number
  favOid?: number
  favType?: number
}

// Schema mirror of BiliVideo, used to validate the on-disk archive/pin maps.
// Optional fav* fields default to undefined when absent.
export const BiliVideoSchema = z
  .object({
    bvid: z.string(),
    title: z.string(),
    cover: z.string(),
    author: z.string(),
    durationSec: z.number(),
    intro: z.string(),
    source: z.string(),
    favMediaId: z.number().optional(),
    favOid: z.number().optional(),
    favType: z.number().optional(),
  })
  .strict()

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

export const TranscriptionConfigSchema = z
  .object({
    ffmpegPath: z.string(),
    modelDir: z.string(),
  })
  .strict()

export type TranscriptionConfig = z.infer<typeof TranscriptionConfigSchema>

export const BilibiliConfigOnDisk = z
  .object({
    credentials: BiliCredentialsSchema.nullable(),
    obsidian: ObsidianConfigSchema.nullable().default(null),
    transcription: TranscriptionConfigSchema.nullable().default(null),
  })
  .strict()

export type BilibiliConfigOnDisk = z.infer<typeof BilibiliConfigOnDisk>

export function defaultBilibiliConfigOnDisk(): BilibiliConfigOnDisk {
  return { credentials: null, obsidian: null, transcription: null }
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

export type BiliAnalysisSource = 'subtitle' | 'transcript'

const BiliSummarySchema = z
  .object({
    gist: z.string(),
    points: z.array(z.string()),
    experience: z.array(z.string()),
    pitfalls: z.array(z.string()),
    steps: z.array(z.string()),
  })
  .strict()

export const BiliAnalysisSchema = z
  .object({
    bvid: z.string(),
    summary: BiliSummarySchema,
    text: z.string(),
    source: z.enum(['subtitle', 'transcript']),
    analyzedAt: z.string(),
  })
  .strict()

export type BiliAnalysis = z.infer<typeof BiliAnalysisSchema>

export type BiliProcessResult =
  | { ok: true; summary: BiliSummary; text: string; source: 'subtitle' }
  | { ok: false; code: 'no_subtitle' | 'no_provider' | 'llm_failed' | 'unknown'; message: string }

// Request from Main → Service to run the bilibili-analyst agent over a
// transcript. Main owns subtitle/transcript fetch + persistence; the service
// only runs the analysis and streams bilibili.analysis* events back.
export type AnalyzeBilibiliRequest = {
  bvid: string
  provider: ProviderInjection
  text: string
  title: string
  author: string
}

export type AnalyzeBilibiliResult =
  | { ok: true; summary: BiliSummary }
  | { ok: false; code: 'no_provider' | 'no_agent' | 'llm_failed' | 'no_card'; message: string }

export type BiliSaveResult =
  | { ok: true; path: string }
  | { ok: false; code: 'no_vault' | 'write_failed'; message: string }

export type BiliTranscribeStage = 'queued' | 'audio' | 'transcribing' | 'summarizing' | 'done' | 'failed'

export type BiliTranscribeProgress = { bvid: string; stage: BiliTranscribeStage }

export type BiliTranscribeResult =
  | { ok: true; summary: BiliSummary; text: string; source: 'transcript' }
  | {
      ok: false
      code: 'no_config' | 'no_provider' | 'audio_failed' | 'ffmpeg_failed' | 'asr_failed' | 'llm_failed' | 'unknown'
      message: string
    }

// Result of deleting a resource from Bilibili (watch-later or a fav folder).
// `not_logged_in` is returned before any network call; other failures surface
// the upstream message so the UI can show it.
export type BiliDeleteResult = { ok: true } | { ok: false; code: 'not_logged_in' | 'unknown'; message: string }
