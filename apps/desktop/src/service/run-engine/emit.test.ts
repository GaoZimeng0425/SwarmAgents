import { describe, expect, it, vi } from 'vitest'

import { createRunEmit, type RunEmitPorts } from './emit'

const makePorts = (): { [K in keyof RunEmitPorts]: ReturnType<typeof vi.fn> } => ({
  nextSeq: vi.fn().mockReturnValueOnce(7).mockReturnValue(8),
  appendEvent: vi.fn(),
  markTerminal: vi.fn(),
  broadcast: vi.fn(),
})

describe('createRunEmit', () => {
  it('stamps sessionId/runId/seq/ts exactly once and hands the SAME object to append and broadcast', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports as RunEmitPorts, { sessionId: 's1', runId: 'r1' })

    emit({ kind: 'run.dispatched' })

    expect(ports.nextSeq).toHaveBeenCalledTimes(1)
    expect(ports.nextSeq).toHaveBeenCalledWith('s1')
    const appended = ports.appendEvent.mock.calls[0][0]
    expect(appended).toMatchObject({ kind: 'run.dispatched', sessionId: 's1', runId: 'r1', seq: 7 })
    expect(typeof appended.ts).toBe('number')
    expect(ports.broadcast.mock.calls[0][0]).toBe(appended)
  })

  it('never mutates the caller input (ledger #13 regression)', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports as RunEmitPorts, { sessionId: 's1', runId: 'r1' })
    const innerEvent = { kind: 'llm.message' as const, role: 'assistant' as const, content: 'hi', ts: 1 }
    const input = { kind: 'run.progress' as const, event: innerEvent }
    Object.freeze(input)
    Object.freeze(innerEvent)

    expect(() => emit(input)).not.toThrow() // a mutation of a frozen object throws in strict mode
    expect(input).toEqual({
      kind: 'run.progress',
      event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 },
    })
  })

  it('stamps seq onto a CLONE of the inner progress event so replay ordering travels with it', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports as RunEmitPorts, { sessionId: 's1', runId: 'r1' })
    const innerEvent = { kind: 'llm.message' as const, role: 'assistant' as const, content: 'hi', ts: 1 }

    emit({ kind: 'run.progress', event: innerEvent })

    const appended = ports.appendEvent.mock.calls[0][0]
    expect(appended.event).not.toBe(innerEvent)
    expect(appended.event.seq).toBe(7)
    expect(innerEvent).not.toHaveProperty('seq')
  })

  it('marks the terminal registry for run.complete and run.error only, with the mapped status', () => {
    const ports = makePorts()
    const emit = createRunEmit(ports as RunEmitPorts, { sessionId: 's1', runId: 'r1' })

    emit({ kind: 'run.progress', event: { kind: 'reasoning', content: 'x', ts: 1 } })
    expect(ports.markTerminal).not.toHaveBeenCalled()

    emit({ kind: 'run.complete', summary: 'done' })
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'completed')

    emit({ kind: 'run.error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' } })
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'cancelled')
  })

  it('swallows a throwing broadcaster: the append row is still written and nothing escapes', () => {
    const ports = makePorts()
    ports.broadcast.mockImplementation(() => {
      throw new Error('dead IPC sink')
    })
    const emit = createRunEmit(ports as RunEmitPorts, { sessionId: 's1', runId: 'r1' })

    expect(() => emit({ kind: 'run.complete', summary: 'done' })).not.toThrow()
    // Persistence + terminal marking happened before the broadcast blew up.
    expect(ports.appendEvent).toHaveBeenCalledTimes(1)
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'completed')
    expect(ports.broadcast).toHaveBeenCalledTimes(1)
  })

  it('includes parentRunId on every event when the identity carries one, and omits it otherwise', () => {
    const ports = makePorts()
    createRunEmit(ports as RunEmitPorts, { sessionId: 's1', runId: 'child', parentRunId: 'parent' })({
      kind: 'run.dispatched',
    })
    expect(ports.appendEvent.mock.calls[0][0].parentRunId).toBe('parent')

    const ports2 = makePorts()
    createRunEmit(ports2 as RunEmitPorts, { sessionId: 's1', runId: 'top' })({ kind: 'run.dispatched' })
    expect('parentRunId' in ports2.appendEvent.mock.calls[0][0]).toBe(false)
  })
})
