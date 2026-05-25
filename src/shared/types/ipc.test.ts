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
      provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
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

describe('Inbound task.assign provider field', () => {
  it('accepts a task.assign with a provider injection', () => {
    const msg = {
      type: 'task.assign' as const,
      task: {
        id: '01HX0000000000000000000001',
        parentId: null,
        goal: 'do thing',
        status: 'pending' as const,
        assignedWorkerId: null,
        toolAllowlist: ['peekaboo.*'],
        budget: { tokens: 100, calls: 10, wallMs: 1000, usdCents: 10 },
        used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
        history: [],
        result: null,
        createdAt: 0,
        startedAt: null,
        endedAt: null,
      },
      promptContext: '',
      provider: { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'sk-x' },
    }
    const parsed = InboundSchema.parse(msg)
    expect(parsed.type).toBe('task.assign')
    if (parsed.type === 'task.assign') {
      expect(parsed.provider.id).toBe('anthropic')
      expect(parsed.provider.apiKey).toBe('sk-x')
    }
  })

  it('rejects task.assign without a provider', () => {
    expect(() =>
      InboundSchema.parse({
        type: 'task.assign',
        task: { id: 'x' } as never,
        promptContext: '',
      }),
    ).toThrow()
  })
})
