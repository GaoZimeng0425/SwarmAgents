import { describe, expect, it, vi } from 'vitest'

import { type CCQuery, type CCQueryFn, type CCRawMessage, createClaudeCodeManager } from './manager'

// A fake SDK query that echoes each user message back as one assistant turn
// (system init on the first turn only) followed by a result. Models the
// streaming-input lifecycle: it stays alive across turns until the input ends.
function echoQueryFn(onInterrupt?: () => void): CCQueryFn {
  return ({ prompt }) => {
    const gen = (async function* (): AsyncGenerator<CCRawMessage, void> {
      let first = true
      for await (const msg of prompt) {
        const text = msg.message.content
        if (first) {
          yield { type: 'system', subtype: 'init', session_id: 'sdk-abc' }
          first = false
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `echo:${text}` }] },
          session_id: 'sdk-abc',
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sdk-abc',
          result: `done:${text}`,
          usage: { input_tokens: 3, output_tokens: 5 },
        }
      }
    })()
    return Object.assign(gen, {
      interrupt: async () => {
        onInterrupt?.()
      },
    }) as CCQuery
  }
}

describe('ClaudeCodeManager', () => {
  it('starts a session and returns the first turn at the pause', async () => {
    const m = createClaudeCodeManager({ queryFn: echoQueryFn(), pauseTimeoutMs: 1000 })
    const obs = await m.start({ ccSessionId: 'cc1', prompt: 'hi', cwd: '/tmp' })

    expect(obs.status).toBe('idle')
    expect(obs.sdkSessionId).toBe('sdk-abc')
    expect(obs.usage).toEqual({ inputTokens: 3, outputTokens: 5 })
    expect(obs.events.map((e) => e.kind)).toEqual(['system', 'text', 'result'])
    expect(obs.events).toContainEqual({ kind: 'text', text: 'echo:hi' })
    expect(m.has('cc1')).toBe(true)
  })

  it('steers a live session with send and accumulates a second turn', async () => {
    const m = createClaudeCodeManager({ queryFn: echoQueryFn(), pauseTimeoutMs: 1000 })
    await m.start({ ccSessionId: 'cc1', prompt: 'hi' })

    const obs = await m.send('cc1', 'now do X')
    expect(obs.status).toBe('idle')
    // No system init on the second turn.
    expect(obs.events.map((e) => e.kind)).toEqual(['text', 'result'])
    expect(obs.events).toContainEqual({ kind: 'text', text: 'echo:now do X' })
  })

  it('drains events: observe after a returning call sees no new events', async () => {
    const m = createClaudeCodeManager({ queryFn: echoQueryFn(), pauseTimeoutMs: 1000 })
    await m.start({ ccSessionId: 'cc1', prompt: 'hi' })

    const obs = m.observe('cc1')
    expect(obs.events).toEqual([])
    expect(obs.status).toBe('idle')
  })

  it('interrupt calls the underlying SDK interrupt', async () => {
    const onInterrupt = vi.fn()
    const m = createClaudeCodeManager({ queryFn: echoQueryFn(onInterrupt), pauseTimeoutMs: 30 })
    await m.start({ ccSessionId: 'cc1', prompt: 'hi' })

    await m.interrupt('cc1')
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('stop ends the session and removes the handle', async () => {
    const m = createClaudeCodeManager({ queryFn: echoQueryFn(), pauseTimeoutMs: 1000 })
    await m.start({ ccSessionId: 'cc1', prompt: 'hi' })

    const obs = m.stop('cc1')
    expect(obs.status).toBe('completed')
    expect(m.has('cc1')).toBe(false)
  })

  it('rejects a duplicate session id', async () => {
    const m = createClaudeCodeManager({ queryFn: echoQueryFn(), pauseTimeoutMs: 1000 })
    await m.start({ ccSessionId: 'cc1', prompt: 'hi' })
    await expect(m.start({ ccSessionId: 'cc1', prompt: 'again' })).rejects.toThrow(/already exists/)
  })

  it('throws on operations against an unknown session', () => {
    const m = createClaudeCodeManager({ queryFn: echoQueryFn() })
    expect(() => m.observe('nope')).toThrow(/no Claude Code session/)
  })

  it('surfaces a failed status when the query loop throws', async () => {
    const failing: CCQueryFn = () => {
      // A query whose stream rejects on first pull, exercising the consume() catch.
      const gen = {
        next: () => Promise.reject(new Error('boom')),
        return: () => Promise.resolve({ value: undefined, done: true } as IteratorResult<CCRawMessage>),
        [Symbol.asyncIterator]() {
          return this
        },
        interrupt: async () => {},
      }
      return gen as unknown as CCQuery
    }
    const m = createClaudeCodeManager({ queryFn: failing, pauseTimeoutMs: 1000 })
    const obs = await m.start({ ccSessionId: 'cc1', prompt: 'hi' })
    expect(obs.status).toBe('failed')
    expect(obs.error).toBe('boom')
    expect(obs.events).toContainEqual({ kind: 'error', text: 'boom' })
  })
})
