import { describe, expect, it } from 'vitest'
import { InboundSchema, OutboundSchema } from './ipc'

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
