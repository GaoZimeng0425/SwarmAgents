import { describe, expect, it } from 'vitest'

import { parseThreadPayload } from './analyze-thread'

describe('parseThreadPayload', () => {
  it('parses a well-formed tail JSON block', () => {
    const md =
      '## 摘要\n要点一\n\n<!--ANALYSIS:{"summary":"一句话","todos":[{"t":"回复","due":true,"dueLabel":"今天"}],"suggest":"好的"}-->'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe('一句话')
    expect(out.todos).toEqual([{ t: '回复', due: true, dueLabel: '今天' }])
    expect(out.suggest).toBe('好的')
  })

  it('degrades gracefully when the tail JSON block is missing', () => {
    const md = '## 摘要\n要点一\n无尾部 JSON'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe(md) // summary falls back to the full markdown
    expect(out.todos).toEqual([])
    expect(out.suggest).toBe('')
  })

  it('degrades gracefully when the tail JSON is malformed', () => {
    const md = '## 摘要\n\n<!--ANALYSIS:{not valid json}-->'
    const out = parseThreadPayload(md)
    expect(out.todos).toEqual([])
    expect(out.suggest).toBe('')
    // summary is the full markdown (the malformed block stays in the streamed text)
    expect(out.summary).toContain('## 摘要')
  })

  it('uses the LAST tail JSON block if multiple appear', () => {
    const md =
      '<!--ANALYSIS:{"summary":"旧","todos":[],"suggest":""}-->\n\n更多内容\n\n<!--ANALYSIS:{"summary":"新","todos":[],"suggest":""}-->'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe('新')
  })
})
