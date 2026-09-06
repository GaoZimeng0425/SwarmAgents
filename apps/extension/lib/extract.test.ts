import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'

import { extractArticleFromDocument } from './extract'

function dom(html: string, url = 'https://example.com/a'): { document: Document; location: Location } {
  const window = new Window({ url })
  window.document.write(html)
  return {
    document: window.document as unknown as Document,
    location: window.location as unknown as Location,
  }
}

describe('extractArticleFromDocument', () => {
  it('extracts an article document', () => {
    const { document, location } = dom(
      `<html><head><title>T</title></head><body><article><h1>T</h1><p>${'long paragraph '.repeat(50)}</article></body></html>`
    )
    const r = extractArticleFromDocument(document, location)
    expect(r).not.toBeNull()
    expect(r?.url).toBe('https://example.com/a')
    expect(r?.title.length).toBeGreaterThan(0)
    expect(r?.contentMarkdown.length).toBeGreaterThan(0)
  })
  it('returns null for a non-article page', () => {
    const { document, location } = dom('<html><body><p>hi</p></body></html>')
    const r = extractArticleFromDocument(document, location)
    expect(r).toBeNull()
  })
})
