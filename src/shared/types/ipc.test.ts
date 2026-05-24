import { describe, expect, it } from 'vitest'

import { AccentColorSchema, ConfirmRequestSchema, ConfirmResponseSchema, InboundSchema, OutboundSchema } from './ipc'

describe('IPC schemas', () => {
  it('accepts a task.assign message', () => {
    const msg = {
      type: 'task.assign',
      task: {
        id: '01HX0000000000000000000000',
        parentId: null,
        goal: 'g',
        status: 'dispatched',
        assignedWorkerId: 'w1',
        toolAllowlist: [],
        budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 1,
        startedAt: null,
        endedAt: null,
      },
      promptContext: 'hello',
    }
    expect(() => InboundSchema.parse(msg)).not.toThrow()
  })

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

  it('accepts a task.complete', () => {
    const msg = {
      type: 'task.complete',
      taskId: '01HX0000000000000000000000',
      result: { summary: 'done', artifacts: [] },
    }
    expect(() => OutboundSchema.parse(msg)).not.toThrow()
  })

  it('rejects an unknown outbound type', () => {
    expect(() => OutboundSchema.parse({ type: 'bogus' })).toThrow()
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

describe('ConfirmRequestSchema', () => {
  it('accepts a minimal request', () => {
    const req = {
      title: 'Continue?',
      message: 'This action will modify files.',
      risk: 'high' as const,
      buttons: [{ label: 'Allow', role: 'grant' as const }],
    }
    expect(ConfirmRequestSchema.parse(req)).toEqual(req)
  })
  it('rejects empty buttons array', () => {
    expect(() => ConfirmRequestSchema.parse({
      title: 't', message: 'm', risk: 'high', buttons: [],
    })).toThrow()
  })
})

describe('ConfirmResponseSchema', () => {
  it('accepts each known role', () => {
    for (const r of ['grant', 'deny', 'skip'] as const) {
      expect(ConfirmResponseSchema.parse(r)).toBe(r)
    }
  })
})
