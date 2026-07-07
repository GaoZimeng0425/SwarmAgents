import { describe, expect, it } from 'vitest'

import { AnalyzeArticleResult, ArticleSource, ArticleSummary, CollectArticleResult } from './article'

const validSource = {
  url: 'https://example.com/a',
  title: 'A Title',
  author: null,
  siteName: null,
  publishedTime: null,
  contentMarkdown: '# body',
}

describe('ArticleSource', () => {
  it('accepts a valid source', () => {
    const r = ArticleSource.safeParse(validSource)
    expect(r.success).toBe(true)
  })
  it('rejects a non-url', () => {
    const r = ArticleSource.safeParse({ ...validSource, url: 'not-a-url' })
    expect(r.success).toBe(false)
  })
  it('rejects empty contentMarkdown', () => {
    const r = ArticleSource.safeParse({ ...validSource, contentMarkdown: '' })
    expect(r.success).toBe(false)
  })
  it('rejects title over 500 chars', () => {
    const r = ArticleSource.safeParse({ ...validSource, title: 'x'.repeat(501) })
    expect(r.success).toBe(false)
  })
})

describe('ArticleSummary', () => {
  it('accepts a valid summary', () => {
    const r = ArticleSummary.safeParse({ gist: 'g', points: ['p'], takeaways: [] })
    expect(r.success).toBe(true)
  })
})

describe('CollectArticleResult', () => {
  it('parses a success', () => {
    const r = CollectArticleResult.safeParse({ ok: true, articleId: '01ABC' })
    expect(r.success).toBe(true)
  })
  it('parses an invalid failure', () => {
    const r = CollectArticleResult.safeParse({ ok: false, code: 'invalid', message: 'bad' })
    expect(r.success).toBe(true)
  })
})

describe('AnalyzeArticleResult', () => {
  it('parses a success', () => {
    const r = AnalyzeArticleResult.safeParse({ ok: true })
    expect(r.success).toBe(true)
  })
  it('parses no_provider', () => {
    const r = AnalyzeArticleResult.safeParse({ ok: false, code: 'no_provider', message: 'm' })
    expect(r.success).toBe(true)
  })
})
