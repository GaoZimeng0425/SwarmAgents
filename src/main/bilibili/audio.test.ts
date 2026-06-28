import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BiliCredentials } from '@shared/types/bilibili'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractWav, FfmpegError } from './audio'

const CRED: BiliCredentials = { sessdata: 's', biliJct: 'j', dedeUserId: 'u' }
let workDir = ''

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'asr-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(workDir, { recursive: true, force: true })
})

type AudioSpawn = import('./audio').AudioDeps['spawn']

// A fake child process whose exit code we control.
function fakeProc(exitCode: number): EventEmitter & { stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
  proc.stderr = new EventEmitter()
  queueMicrotask(() => proc.emit('close', exitCode))
  return proc
}

describe('extractWav', () => {
  it('downloads the m4s, runs ffmpeg with 16k mono args, cleans up, and returns the wav path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
    const spawn = vi.fn(() => fakeProc(0)) as unknown as AudioSpawn
    const wav = await extractWav(
      { spawn },
      { audioUrl: 'https://x/low.m4s', c: CRED, ffmpegPath: '/usr/bin/ffmpeg', workDir, bvid: 'BV1' }
    )
    expect(wav).toBe(join(workDir, 'BV1.wav'))
    // ffmpeg args must request 16kHz mono PCM wav
    const call = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(call[0]).toBe('/usr/bin/ffmpeg')
    expect(call[1]).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-f', 'wav']))
    // intermediate m4s removed
    await expect(fs.access(join(workDir, 'BV1.m4s'))).rejects.toThrow()
  })

  it('throws FfmpegError on non-zero ffmpeg exit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1])))
    const spawn = vi.fn(() => fakeProc(1)) as unknown as AudioSpawn
    await expect(
      extractWav({ spawn }, { audioUrl: 'https://x/low.m4s', c: CRED, ffmpegPath: 'ffmpeg', workDir, bvid: 'BV1' })
    ).rejects.toBeInstanceOf(FfmpegError)
  })

  it('throws a plain Error when the audio download fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    const spawn = vi.fn(() => fakeProc(0)) as unknown as AudioSpawn
    await expect(
      extractWav({ spawn }, { audioUrl: 'https://x/low.m4s', c: CRED, ffmpegPath: 'ffmpeg', workDir, bvid: 'BV1' })
    ).rejects.not.toBeInstanceOf(FfmpegError)
  })
})
