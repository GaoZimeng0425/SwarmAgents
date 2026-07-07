import { describe, expect, it } from 'vitest'

import { createCollectArticle } from './collect'
import type { ArticleStore } from './store'

function fakeStore(): ArticleStore {
  const added: unknown[] = []
  return {
    add(input) {
      added.push(input)
      return {
        ...input,
        id: '01ID',
        collectedAt: '2026-07-07T00:00:00.000Z',
        excerpt: input.contentMarkdown.slice(0, 300),
      }
    },
    list: () => [],
    get: () => null,
    saveAnalysis: () => undefined,
    delete: () => undefined,
  }
}

const valid = {
  url: 'https://example.com/a',
  title: 'A',
  author: null,
  siteName: null,
  publishedTime: null,
  contentMarkdown: 'body',
}

describe('createCollectArticle', () => {
  it('accepts valid input and returns articleId', () => {
    const collect = createCollectArticle({ store: fakeStore() })
    const r = collect(valid)
    expect(r).toEqual({ ok: true, articleId: '01ID' })
  })
  it('rejects invalid url', () => {
    const collect = createCollectArticle({ store: fakeStore() })
    const r = collect({ ...valid, url: 'nope' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid')
  })
})
