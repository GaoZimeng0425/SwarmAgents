import { describe, expect, it } from 'vitest'

import { SessionEntrySchema } from './session-entry'

describe('SessionEntrySchema', () => {
  it('parses a message entry', () => {
    const e = {
      type: 'message',
      id: '018f-aaa',
      parentId: null,
      timestamp: '2026-07-16T00:00:00Z',
      message: { role: 'user', content: 'hello', timestamp: '2026-07-16T00:00:00Z' },
    }
    expect(SessionEntrySchema.parse(e)).toEqual(e)
  })
  it('parses a custom entry with arbitrary data', () => {
    const e = {
      type: 'custom',
      id: '018f-bbb',
      parentId: '018f-aaa',
      timestamp: '2026-07-16T00:00:01Z',
      customType: 'delegation',
      data: { childSessionId: 's2', agentDefId: 'engineer' },
    }
    expect(SessionEntrySchema.parse(e)).toEqual(e)
  })
  it('rejects unknown entry types', () => {
    expect(() => SessionEntrySchema.parse({ type: 'nope', id: 'x', parentId: null, timestamp: 't' })).toThrow()
  })
})
