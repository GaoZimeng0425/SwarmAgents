import { describe, expect, it } from 'vitest'

import { splitMarkdownBlocks } from './block-splitter'
import {
  estimateByCharCount,
  estimateMarkdownHeight,
  estimateOpaqueHeight,
  FALLBACK_LINE_HEIGHT,
  MAX_MEASURABLE_CHARS,
} from './height-model'
import { createTextMetricsService } from './pretext-service'

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    const blocks = splitMarkdownBlocks('第一段。\n\n第二段。')
    expect(blocks).toEqual([
      { kind: 'text', text: '第一段。' },
      { kind: 'text', text: '第二段。' },
    ])
  })

  it('collapses single newlines inside a paragraph to spaces', () => {
    const blocks = splitMarkdownBlocks('one\ntwo\nthree')
    expect(blocks).toEqual([{ kind: 'text', text: 'one two three' }])
  })

  it('turns fenced code into one opaque block, preserving order', () => {
    const blocks = splitMarkdownBlocks('before\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nafter')
    expect(blocks).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'opaque', text: '```ts\nconst a = 1\nconst b = 2\n```' },
      { kind: 'text', text: 'after' },
    ])
  })

  it('treats an unclosed fence (streaming tail) as opaque', () => {
    const blocks = splitMarkdownBlocks('text\n\n```\nstill typing')
    expect(blocks).toEqual([
      { kind: 'text', text: 'text' },
      { kind: 'opaque', text: '```\nstill typing' },
    ])
  })
})

describe('height model', () => {
  const measure = (text: string, width: number): number =>
    Math.ceil([...text].length / Math.floor(width / 10)) * FALLBACK_LINE_HEIGHT

  it('estimates opaque blocks from line count plus chrome', () => {
    expect(estimateOpaqueHeight('a\nb\nc')).toBe(3 * FALLBACK_LINE_HEIGHT + 16)
  })

  it('degrades over-long runs to character-count estimates', () => {
    const long = 'x'.repeat(MAX_MEASURABLE_CHARS + 1)
    const expected = estimateByCharCount(long, 736)
    expect(expected).toBeGreaterThan(0)
    // measureText must not be consulted for the over-long block.
    expect(estimateMarkdownHeight(long, 736, measure)).toBe(expected)
  })

  it('composes markdown height from text + opaque blocks', () => {
    const md = 'para\n\n```\nline\n```\n\npara2'
    const expected = measure('para', 736) + estimateOpaqueHeight('```\nline\n```') + measure('para2', 736)
    expect(estimateMarkdownHeight(md, 736, measure)).toBe(expected)
  })
})

describe('createTextMetricsService', () => {
  function fakeBackend(lineCount = 2) {
    const token = { fake: true }
    const calls: string[] = []
    return {
      calls,
      prepare: (text: string) => {
        calls.push(text)
        return token as unknown as import('@chenglou/pretext').PreparedText
      },
      layout: () => ({ height: lineCount * FALLBACK_LINE_HEIGHT, lineCount }),
    }
  }

  const probeFont = () => ({ family: 'Test Sans', weight: '400', size: 14 })

  it('caches prepare() per text', () => {
    const backend = fakeBackend()
    const svc = createTextMetricsService({ probeFont, ...backend })
    svc.estimateMarkdownHeight('同一段文字', 736)
    svc.estimateMarkdownHeight('同一段文字', 736)
    expect(backend.calls).toEqual(['同一段文字'])
  })

  it('clamps to at least one rendered line', () => {
    const backend = fakeBackend()
    backend.layout = () => ({ height: 0, lineCount: 0 })
    const svc = createTextMetricsService({ probeFont, ...backend })
    // Whitespace-only markdown yields no blocks → 0 (the DOM renders nothing).
    expect(svc.estimateMarkdownHeight('   ', 736)).toBe(0)
    // A real block whose layout reports zero lines still renders one line.
    expect(svc.estimateMarkdownHeight('a', 736)).toBe(FALLBACK_LINE_HEIGHT)
  })

  it('skips prepare() beyond the measurable-char cap', () => {
    const backend = fakeBackend()
    const svc = createTextMetricsService({ probeFont, ...backend })
    const long = `${'字'.repeat(30)}\n\n${'x'.repeat(MAX_MEASURABLE_CHARS + 1)}`
    svc.estimateMarkdownHeight(long, 736)
    expect(backend.calls).toEqual(['字'.repeat(30)])
  })

  it('evicts the oldest entries beyond the LRU capacity', () => {
    const backend = fakeBackend()
    const svc = createTextMetricsService({ probeFont, ...backend })
    for (let i = 0; i < 2001; i++) svc.estimateMarkdownHeight(`t${i}`, 736)
    expect(svc.size()).toBeLessThanOrEqual(2000)
  })
})
