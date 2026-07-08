import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createArticleStore } from './store'

const sample = {
  url: 'https://example.com/a',
  title: 'A',
  author: null,
  siteName: 'Ex',
  publishedTime: null,
  contentMarkdown: 'body text here',
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'swarm-article-'))
}

describe('createArticleStore', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('add returns the article with id/excerpt and persists', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add(sample)
    expect(a.id).toBeTruthy()
    expect(a.excerpt).toBe('body text here')
    expect(a.collectedAt).toBeTruthy()
    // persisted to disk
    const raw = JSON.parse(readFileSync(join(dir, 'collected-articles.json'), 'utf8'))
    expect(raw[a.id].title).toBe('A')
  })

  it('list returns newest-first and includes analysis cache', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a1 = store.add(sample)
    const a2 = store.add({ ...sample, title: 'B' })
    const list = store.list()
    expect(list[0].id).toBe(a2.id)
    expect(list[1].id).toBe(a1.id)
    expect(list[0].summary).toBeNull()
  })

  it('list is deterministic for same-ms adds (newest-first by insertion)', () => {
    const store = createArticleStore({ userDataDir: dir })
    // Force same collectedAt by stubbing Date is overkill; instead add several
    // and assert strict reverse-insertion order regardless of ulid randomness.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const a = store.add({ ...sample, title: `T${i}` })
      ids.push(a.id)
    }
    const list = store.list()
    // newest-first = reverse insertion order
    expect(list.map((a) => a.id)).toEqual([...ids].reverse())
  })

  it('saveAnalysis attaches summary and analyzedAt', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add(sample)
    store.saveAnalysis(a.id, { gist: 'g', points: ['p'], takeaways: [] })
    const got = store.get(a.id)
    expect(got?.summary?.gist).toBe('g')
    expect(got?.analyzedAt).toBeTruthy()
  })

  it('delete removes the record', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add(sample)
    store.delete(a.id)
    expect(store.get(a.id)).toBeNull()
  })

  it('reload reads persisted state', () => {
    const store1 = createArticleStore({ userDataDir: dir })
    store1.add(sample)
    const store2 = createArticleStore({ userDataDir: dir })
    expect(store2.list()).toHaveLength(1)
  })

  it('excerpt truncates to 300 chars', () => {
    const store = createArticleStore({ userDataDir: dir })
    const a = store.add({ ...sample, contentMarkdown: 'x'.repeat(500) })
    expect(a.excerpt.length).toBe(300)
  })

  it('watch fires on add, saveAnalysis, and delete', () => {
    const store = createArticleStore({ userDataDir: dir })
    const calls: number[] = []
    const off = store.watch(() => calls.push(Date.now()))
    const a = store.add(sample)
    store.saveAnalysis(a.id, { gist: 'g', points: [], takeaways: [] })
    store.delete(a.id)
    off()
    // No further fires after dispose:
    store.add(sample)
    expect(calls).toHaveLength(3)
  })
})
