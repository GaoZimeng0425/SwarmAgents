import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BiliAnalysis } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAnalysisStore } from './analysis-store'

let filePath = ''
const ENTRY: BiliAnalysis = {
  bvid: 'BV1',
  summary: { gist: 'g', points: ['p'], experience: [], pitfalls: [], steps: [] },
  text: '全文内容',
  source: 'subtitle',
  analyzedAt: '2026-06-28T00:00:00.000Z',
}

beforeEach(async () => {
  filePath = join(await fs.mkdtemp(join(tmpdir(), 'bili-analysis-')), 'a.json')
})
afterEach(async () => {
  await fs.rm(join(filePath, '..'), { recursive: true, force: true })
})

describe('analysis store', () => {
  it('returns null / empty when the file is missing', () => {
    const s = createAnalysisStore({ filePath })
    expect(s.get('BV1')).toBeNull()
    expect(s.bvids()).toEqual([])
  })

  it('round-trips an entry and lists its bvid', async () => {
    const s = createAnalysisStore({ filePath })
    await s.put(ENTRY)
    expect(s.get('BV1')).toEqual(ENTRY)
    expect(s.bvids()).toEqual(['BV1'])
    const s2 = createAnalysisStore({ filePath })
    expect(s2.get('BV1')).toEqual(ENTRY)
  })

  it('overwrites an existing bvid', async () => {
    const s = createAnalysisStore({ filePath })
    await s.put(ENTRY)
    await s.put({ ...ENTRY, text: '新的全文', source: 'transcript' })
    expect(s.get('BV1')?.text).toBe('新的全文')
    expect(s.bvids()).toEqual(['BV1'])
  })

  it('treats a corrupt file as empty', async () => {
    await fs.writeFile(filePath, 'not json')
    const s = createAnalysisStore({ filePath })
    expect(s.bvids()).toEqual([])
  })
})
