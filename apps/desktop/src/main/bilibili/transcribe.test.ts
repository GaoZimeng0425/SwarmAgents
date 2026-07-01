import { afterEach, describe, expect, it, vi } from 'vitest'

import { __clearRecognizerCache, type RecognizerFactory, transcribeWav } from './transcribe'

afterEach(() => __clearRecognizerCache())

describe('transcribeWav', () => {
  it('returns the recognizer text for the wav', async () => {
    const factory: RecognizerFactory = () => ({ transcribe: () => '识别出来的文字' })
    const text = await transcribeWav({ wavPath: '/tmp/a.wav', modelDir: '/models/sv' }, factory)
    expect(text).toBe('识别出来的文字')
  })

  it('builds the recognizer once per modelDir and reuses it', async () => {
    const build = vi.fn((_dir: string) => ({ transcribe: () => 'x' }))
    const factory: RecognizerFactory = (dir) => build(dir)
    await transcribeWav({ wavPath: '/tmp/a.wav', modelDir: '/models/sv' }, factory)
    await transcribeWav({ wavPath: '/tmp/b.wav', modelDir: '/models/sv' }, factory)
    expect(build).toHaveBeenCalledTimes(1)
    await transcribeWav({ wavPath: '/tmp/c.wav', modelDir: '/models/other' }, factory)
    expect(build).toHaveBeenCalledTimes(2)
  })
})
