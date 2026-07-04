import { describe, expect, it } from 'vitest'

import type { RunEmitInput } from './emit'
import { createRunTranslator } from './translator'

const collect = (): { out: RunEmitInput[]; emit: (i: RunEmitInput) => void } => {
  const out: RunEmitInput[] = []
  return { out, emit: (i) => out.push(i) }
}

const textDelta = (delta: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
const thinkingDelta = (delta: string) => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'thinking_delta', delta },
})

describe('createRunTranslator', () => {
  it('buffers text deltas and flushes at a sentence boundary as run.progress llm.message', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(textDelta('Hello ') as never)
    expect(out).toHaveLength(0) // no boundary yet
    t.handle(textDelta('world.') as never)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'run.progress', event: { kind: 'llm.message', content: 'Hello world.' } })
    expect(t.outcome().summary).toBe('Hello world.')
  })

  it('flushes thinking before text so reasoning precedes the answer', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(thinkingDelta('pondering...') as never)
    t.handle(textDelta('Answer.') as never)

    expect(out.map((e) => (e as { event: { kind: string } }).event.kind)).toEqual(['reasoning', 'llm.message'])
  })

  it('emits tool.call / tool.result progress with callId correlation', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle({ type: 'tool_execution_start', toolName: 'read_file', args: { p: 1 }, toolCallId: 'c1' } as never)
    t.handle({
      type: 'tool_execution_end',
      toolName: 'read_file',
      toolCallId: 'c1',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }] },
    } as never)

    expect(out[0]).toMatchObject({
      kind: 'run.progress',
      event: { kind: 'tool.call', tool: 'read_file', callId: 'c1' },
    })
    expect(out[1]).toMatchObject({
      kind: 'run.progress',
      event: { kind: 'tool.result', ok: true, callId: 'c1', payload: { kind: 'text', text: 'ok' } },
    })
  })

  it('surfaces update_plan structured todos as run.plan', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)
    const todos = [{ content: 'a', status: 'pending' }]

    t.handle({
      type: 'tool_execution_end',
      toolName: 'update_plan',
      isError: false,
      result: { content: [{ type: 'text', text: 'Plan' }], details: { todos } },
    } as never)

    expect(out.some((e) => e.kind === 'run.plan' && (e as { todos: unknown }).todos === todos)).toBe(true)
  })

  it('NEVER emits a terminal: a clean agent_end yields progress only + a clean outcome', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(textDelta('done.') as never)
    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'end_turn' }] } as never)

    expect(out.every((e) => e.kind === 'run.progress' || e.kind === 'run.plan')).toBe(true)
    expect(t.outcome()).toEqual({ summary: 'done.', errorMessage: null, sawAborted: false })
  })

  it('captures a request failure (stopReason error) into the outcome without emitting run.error', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle({ type: 'message_end', message: { stopReason: 'error', errorMessage: 'boom 503' } } as never)
    t.handle({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom 503' }],
    } as never)

    expect(t.outcome().errorMessage).toBe('boom 503')
    expect(out.filter((e) => e.kind !== 'run.progress' && e.kind !== 'run.plan')).toHaveLength(0)
  })

  it('records an aborted turn into the outcome and stays silent', () => {
    const { out, emit } = collect()
    const t = createRunTranslator(emit)

    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] } as never)

    expect(t.outcome().sawAborted).toBe(true)
    expect(out).toHaveLength(0)
  })

  it('resetTurn clears summary, error, and aborted for the next attempt', () => {
    const { emit } = collect()
    const t = createRunTranslator(emit)

    t.handle(textDelta('partial.') as never)
    t.handle({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'x' }] } as never)
    t.resetTurn()

    expect(t.outcome()).toEqual({ summary: '', errorMessage: null, sawAborted: false })
  })
})
