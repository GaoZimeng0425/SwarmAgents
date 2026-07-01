// Downloads a DASH audio m4s (with Bilibili's required cookie/UA/Referer) and
// transcodes it to 16 kHz mono PCM WAV via the system ffmpeg — the input format
// sherpa-onnx's offline recognizer expects. ffmpeg is injected via deps.spawn so
// the transcode is unit-testable without a real binary.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@shared/logger'
import type { BiliCredentials } from '@swarm/protocol'

import { BILI_REFERER, BILI_UA, cookieHeader } from './api'

const log = createLogger({ process: 'main' }).child({ component: 'bilibili-audio' })

// Distinguishes an ffmpeg failure (binary missing / non-zero exit) from a
// network failure, so the queue can map each to the right user-facing code.
export class FfmpegError extends Error {}

export type AudioDeps = { spawn: typeof spawn }
export const defaultAudioDeps: AudioDeps = { spawn }

export type ExtractWavArgs = {
  audioUrl: string
  c: BiliCredentials
  ffmpegPath: string
  workDir: string
  bvid: string
}

function runFfmpeg(deps: AudioDeps, ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = deps.spawn(ffmpegPath, args)
    let stderr = ''
    proc.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    proc.on('error', (err) => reject(new FfmpegError(err.message)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new FfmpegError(`ffmpeg exited ${code}: ${stderr.slice(-200)}`))
    })
  })
}

export async function extractWav(deps: AudioDeps, args: ExtractWavArgs): Promise<string> {
  const m4s = join(args.workDir, `${args.bvid}.m4s`)
  const wav = join(args.workDir, `${args.bvid}.wav`)
  log.info({ msg: 'audio extract started', bvid: args.bvid })

  const res = await fetch(args.audioUrl, {
    headers: { 'User-Agent': BILI_UA, Referer: BILI_REFERER, cookie: cookieHeader(args.c) },
  })
  if (!res.ok) {
    log.error({ msg: 'audio download failed', bvid: args.bvid, status: res.status })
    throw new Error(`audio download HTTP ${res.status}`)
  }
  await fs.writeFile(m4s, Buffer.from(await res.arrayBuffer()))

  try {
    // -y overwrite, -ac 1 mono, -ar 16000 16kHz, -f wav PCM container
    await runFfmpeg(deps, args.ffmpegPath, ['-y', '-i', m4s, '-ac', '1', '-ar', '16000', '-f', 'wav', wav])
  } finally {
    await fs.rm(m4s, { force: true })
  }
  log.info({ msg: 'audio extract ok', bvid: args.bvid })
  return wav
}
