import { describe, expect, it } from 'vitest'

import { listArtifacts } from './artifacts-service'

describe('listArtifacts', () => {
  it('includes bilibili analyses from the injected source', async () => {
    const bilibili = async () => [{ bvid: 'BV1xx', title: 'RAG 教程', origin: 'Bilibili' }]
    const out = await listArtifacts({ bilibiliSource: bilibili })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('RAG 教程')
    expect(out[0].ref).toBe('BV1xx')
    expect(out[0].kind).toBe('bilibili-analysis')
    expect(out[0].origin).toBe('Bilibili')
  })

  it('returns empty array when no source has entries', async () => {
    const out = await listArtifacts({ bilibiliSource: async () => [] })
    expect(out).toEqual([])
  })
})
