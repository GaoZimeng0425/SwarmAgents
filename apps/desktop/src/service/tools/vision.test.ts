import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { ToolRunContext } from './registry'
import { analyzeImageSpec, mimeFromPath, ocrImageSpec, pickVisionInjection } from './vision'

const inj = (id: string) => ({ id, model: id, apiStyle: 'anthropic', apiKey: 'k' }) as never

// A minimal ToolRunContext — analyze_image reads ctx.cwd and ctx.analyzeImage.
const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext => over as never

let dir = ''
let pngPath = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vision-'))
  pngPath = join(dir, 'shot.png')
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // "\x89PNG" header bytes
})

const run = (tool: ReturnType<ReturnType<typeof analyzeImageSpec>['build']>, params: unknown) =>
  tool.execute('id', params) as Promise<{ content: { text?: string }[]; details?: { error?: unknown } }>

describe('mimeFromPath', () => {
  it('maps known image extensions and rejects others', () => {
    expect(mimeFromPath('/a/b.png')).toBe('image/png')
    expect(mimeFromPath('/a/b.JPG')).toBe('image/jpeg')
    expect(mimeFromPath('/a/b.webp')).toBe('image/webp')
    expect(mimeFromPath('/a/b.txt')).toBeUndefined()
  })
})

describe('pickVisionInjection', () => {
  it('returns the first injection the predicate accepts (primary preferred over fallbacks)', () => {
    const supports = (p: { id: string }) => p.id !== 'text-only'
    expect(pickVisionInjection([inj('text-only'), inj('vision-a'), inj('vision-b')], supports)?.id).toBe('vision-a')
  })
  it('returns undefined when nothing in the chain is image-capable', () => {
    expect(pickVisionInjection([inj('a'), inj('b')], () => false)).toBeUndefined()
  })
})

describe('analyze_image tool', () => {
  it('reads the image, calls ctx.analyzeImage with base64 + mime, and returns the model text', async () => {
    const analyzeImage = vi.fn(async () => 'Invoice #42, total $9.99')
    const tool = analyzeImageSpec().build(ctx({ analyzeImage }))

    const res = await run(tool, { path: pngPath, prompt: 'Read the invoice' })

    expect(analyzeImage).toHaveBeenCalledWith('Read the invoice', {
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
    })
    expect(res.content[0].text).toBe('Invoice #42, total $9.99')
  })

  it('defaults to an OCR prompt when none is given', async () => {
    const analyzeImage = vi.fn(async () => 'text')
    const tool = analyzeImageSpec().build(ctx({ analyzeImage }))

    await run(tool, { path: pngPath })

    expect((analyzeImage.mock.calls[0] as unknown as [string])[0].toLowerCase()).toContain('ocr')
  })

  it('resolves a relative path against the working directory', async () => {
    const analyzeImage = vi.fn(async () => 'ok')
    const tool = analyzeImageSpec().build(ctx({ analyzeImage, cwd: dir }))

    const res = await run(tool, { path: 'shot.png' })

    expect(res.content[0].text).toBe('ok')
    expect(analyzeImage).toHaveBeenCalledOnce()
  })

  it('returns an error result (does not throw) for a missing file', async () => {
    const analyzeImage = vi.fn(async () => 'unused')
    const tool = analyzeImageSpec().build(ctx({ analyzeImage }))

    const res = await run(tool, { path: join(dir, 'nope.png') })

    expect(analyzeImage).not.toHaveBeenCalled()
    expect(res.details?.error).toBeTruthy()
  })

  it('returns an error result for an unsupported file type', async () => {
    const txt = join(dir, 'note.txt')
    writeFileSync(txt, 'hello')
    const analyzeImage = vi.fn(async () => 'unused')
    const tool = analyzeImageSpec().build(ctx({ analyzeImage }))

    const res = await run(tool, { path: txt })

    expect(analyzeImage).not.toHaveBeenCalled()
    expect(res.details?.error).toBeTruthy()
  })

  it('returns an error result when no image-capable model is configured (ctx.analyzeImage absent)', async () => {
    const tool = analyzeImageSpec().build(ctx({}))

    const res = await run(tool, { path: pngPath })

    expect(res.details?.error).toBeTruthy()
    expect(res.content[0].text?.toLowerCase()).toContain('image-capable')
  })
})

describe('ocr_image tool', () => {
  it('runs local OCR on the resolved path and returns the recognized text', async () => {
    const runOcr = vi.fn(async () => 'line one\nline two')
    const tool = ocrImageSpec(runOcr).build(ctx({ cwd: dir }))

    const res = await run(tool, { path: 'shot.png' })

    expect(runOcr).toHaveBeenCalledWith(pngPath)
    expect(res.content[0].text).toBe('line one\nline two')
  })

  it('returns an error result for an unsupported file type without running OCR', async () => {
    const txt = join(dir, 'note2.txt')
    writeFileSync(txt, 'hello')
    const runOcr = vi.fn(async () => 'unused')
    const tool = ocrImageSpec(runOcr).build(ctx())

    const res = await run(tool, { path: txt })

    expect(runOcr).not.toHaveBeenCalled()
    expect(res.details?.error).toBeTruthy()
  })

  it('surfaces an OCR failure (e.g. swift unavailable) as an error result, not a throw', async () => {
    const runOcr = vi.fn(async () => {
      throw new Error('local OCR unavailable (swift): spawn swift ENOENT')
    })
    const tool = ocrImageSpec(runOcr).build(ctx())

    const res = await run(tool, { path: pngPath })

    expect(res.details?.error).toBeTruthy()
    expect(res.content[0].text).toContain('swift')
  })
})
