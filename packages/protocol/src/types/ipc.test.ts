import { describe, expect, it } from 'vitest'

import { AccentColorSchema, InboundSchema, OutboundSchema } from './ipc'

describe('IPC schemas', () => {
  it('accepts a tool.call outbound', () => {
    const msg = {
      type: 'tool.call',
      callId: 'c1',
      server: 'peekaboo',
      tool: 'see',
      args: { id: 'X' },
    }
    expect(() => OutboundSchema.parse(msg)).not.toThrow()
  })

  it('accepts a heartbeat', () => {
    expect(() => OutboundSchema.parse({ type: 'heartbeat', ts: 123 })).not.toThrow()
  })

  it('rejects an unknown outbound type', () => {
    expect(() => OutboundSchema.parse({ type: 'bogus' })).toThrow()
  })

  it('accepts a tool.result inbound', () => {
    expect(() =>
      InboundSchema.parse({
        type: 'tool.result',
        callId: 'c1',
        result: { ok: true, payload: { kind: 'text', text: 'ok' } },
      })
    ).not.toThrow()
  })
})

describe('AccentColorSchema', () => {
  it('accepts a 6-hex string', () => {
    expect(AccentColorSchema.parse({ hex: '0080ff' })).toEqual({ hex: '0080ff' })
  })
  it('accepts an 8-hex string (RRGGBBAA)', () => {
    expect(AccentColorSchema.parse({ hex: '0080ffFF' })).toEqual({ hex: '0080ffFF' })
  })
  it('rejects non-hex characters', () => {
    expect(() => AccentColorSchema.parse({ hex: 'notahex' })).toThrow()
  })
})
