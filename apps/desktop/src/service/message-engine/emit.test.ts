import { describe, expect, it, vi } from 'vitest'

import { createMessageEmit, type MessageEmitPorts } from './emit'

const makePorts = (): { [K in keyof MessageEmitPorts]: ReturnType<typeof vi.fn> } => ({
  nextSeq: vi.fn().mockReturnValueOnce(7).mockReturnValue(8),
  appendEvent: vi.fn(),
  markTerminal: vi.fn(),
  broadcast: vi.fn(),
})

describe('createMessageEmit', () => {
  it('stamps sessionId/messageId/seq/ts exactly once and hands the SAME object to append and broadcast', () => {
    const ports = makePorts()
    const emit = createMessageEmit(ports as MessageEmitPorts, { sessionId: 's1', messageId: 'r1' })

    emit({ kind: 'message.dispatched' })

    expect(ports.nextSeq).toHaveBeenCalledTimes(1)
    expect(ports.nextSeq).toHaveBeenCalledWith('s1')
    const appended = ports.appendEvent.mock.calls[0][0]
    expect(appended).toMatchObject({ kind: 'message.dispatched', sessionId: 's1', messageId: 'r1', seq: 7 })
    expect(typeof appended.ts).toBe('number')
    expect(ports.broadcast.mock.calls[0][0]).toBe(appended)
  })

  it('never mutates the caller input (ledger #13 regression)', () => {
    const ports = makePorts()
    const emit = createMessageEmit(ports as MessageEmitPorts, { sessionId: 's1', messageId: 'r1' })
    const innerEvent = { kind: 'llm.message' as const, role: 'assistant' as const, content: 'hi', ts: 1 }
    const input = { kind: 'message.progress' as const, event: innerEvent }
    Object.freeze(input)
    Object.freeze(innerEvent)

    expect(() => emit(input)).not.toThrow() // a mutation of a frozen object throws in strict mode
    expect(input).toEqual({
      kind: 'message.progress',
      event: { kind: 'llm.message', role: 'assistant', content: 'hi', ts: 1 },
    })
  })

  it('stamps seq onto a CLONE of the inner progress event so replay ordering travels with it', () => {
    const ports = makePorts()
    const emit = createMessageEmit(ports as MessageEmitPorts, { sessionId: 's1', messageId: 'r1' })
    const innerEvent = { kind: 'llm.message' as const, role: 'assistant' as const, content: 'hi', ts: 1 }

    emit({ kind: 'message.progress', event: innerEvent })

    const appended = ports.appendEvent.mock.calls[0][0]
    expect(appended.event).not.toBe(innerEvent)
    expect(appended.event.seq).toBe(7)
    expect(innerEvent).not.toHaveProperty('seq')
  })

  it('marks the terminal registry for run.complete and run.error only, with the mapped status', () => {
    const ports = makePorts()
    const emit = createMessageEmit(ports as MessageEmitPorts, { sessionId: 's1', messageId: 'r1' })

    emit({ kind: 'message.progress', event: { kind: 'reasoning', content: 'x', ts: 1 } })
    expect(ports.markTerminal).not.toHaveBeenCalled()

    emit({ kind: 'message.complete', summary: 'done' })
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'completed')

    emit({ kind: 'message.error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' } })
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'cancelled')
  })

  it('swallows a throwing broadcaster: the append row is still written and nothing escapes', () => {
    const ports = makePorts()
    ports.broadcast.mockImplementation(() => {
      throw new Error('dead IPC sink')
    })
    const emit = createMessageEmit(ports as MessageEmitPorts, { sessionId: 's1', messageId: 'r1' })

    expect(() => emit({ kind: 'message.complete', summary: 'done' })).not.toThrow()
    // Persistence + terminal marking happened before the broadcast blew up.
    expect(ports.appendEvent).toHaveBeenCalledTimes(1)
    expect(ports.markTerminal).toHaveBeenCalledWith('r1', 'completed')
    expect(ports.broadcast).toHaveBeenCalledTimes(1)
  })

  it('includes parentMessageId on every event when the identity carries one, and omits it otherwise', () => {
    const ports = makePorts()
    createMessageEmit(ports as MessageEmitPorts, { sessionId: 's1', messageId: 'child', parentMessageId: 'parent' })({
      kind: 'message.dispatched',
    })
    expect(ports.appendEvent.mock.calls[0][0].parentMessageId).toBe('parent')

    const ports2 = makePorts()
    createMessageEmit(ports2 as MessageEmitPorts, { sessionId: 's1', messageId: 'top' })({ kind: 'message.dispatched' })
    expect('parentMessageId' in ports2.appendEvent.mock.calls[0][0]).toBe(false)
  })
})
