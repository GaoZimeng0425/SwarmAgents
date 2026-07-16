import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createLogger } from '@shared/logger'
import type { AgentWireEvent } from '@swarm/protocol'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { SessionAgent } from './session-agent'
import { createEntryStore, ensureEntriesSchema } from './sqlite-storage'

// Minimal pi Model<Api> — only the fields SessionAgent actually reads
// (id/contextWindow for turn_end's usage snapshot). The fake streamFn means
// no network call ever inspects the rest of the shape.
const FAKE_MODEL = {
  id: 'fake-model',
  name: 'Fake Model',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
} as unknown as Model<Api>

function silentLogger(): Logger {
  const log = createLogger({ process: 'test' })
  log.level = 'silent'
  return log
}

const fakeUsage = () => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

function fakeAssistantMessage(
  text: string,
  opts: { stopReason?: 'stop' | 'error' | 'aborted'; errorMessage?: string } = {}
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fake-model',
    usage: fakeUsage(),
    stopReason: opts.stopReason ?? 'stop',
    errorMessage: opts.errorMessage,
    timestamp: Date.now(),
  } as AssistantMessage
}

/**
 * Builds a real pi AssistantMessageEventStream (per pi's own faux-provider
 * trick) — a bare async generator fails at runtime because agent-loop.js
 * calls `response.result()` on the stream in addition to iterating it.
 */
function streamOf(message: AssistantMessage, deltas: string[] = [(message.content[0] as { text: string }).text]) {
  const stream = createAssistantMessageEventStream()
  stream.push({ type: 'start', partial: message })
  for (const delta of deltas) stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message })
  if (message.stopReason === 'stop') stream.push({ type: 'done', reason: 'stop', message })
  else stream.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message })
  return stream
}

/** Builds a StreamFn that replies with the queued assistant messages, one per LLM call. */
function fakeStream(
  replies: Array<{ text: string; stopReason?: 'stop' | 'error' | 'aborted'; errorMessage?: string }>
) {
  let call = 0
  return () => {
    const r = replies[Math.min(call++, replies.length - 1)]
    return streamOf(fakeAssistantMessage(r.text, r))
  }
}

function makeStore() {
  const db = new Database(':memory:')
  ensureEntriesSchema(db)
  return createEntryStore(db)
}

const makeAgent = (streamReplies: Parameters<typeof fakeStream>[0]) => {
  const entries = makeStore()
  const events: AgentWireEvent[] = []
  const agent = new SessionAgent({
    sessionId: 's1',
    entries,
    broadcast: (e) => events.push(e),
    acquireSlot: async () => () => {},
    buildAgentConfig: () => ({
      systemPrompt: 'test',
      model: FAKE_MODEL,
      thinkingLevel: 'off',
      tools: [],
      maxTurns: 5,
      streamFn: fakeStream(streamReplies),
    }),
    log: silentLogger(),
  })
  return { agent, entries, events }
}

describe('SessionAgent', () => {
  it('persists the user entry at submit, in causal position', () => {
    const { agent, entries, events } = makeAgent([{ text: 'hi!' }])
    agent.submitUserMessage('hello')
    const rows = entries.list('s1')
    expect(rows[0].entry.type).toBe('message')
    expect(events[0].kind).toBe('entry_appended')
  })

  it('runs to completion: assistant entry persisted exactly once, agent_end completed', async () => {
    const { agent, entries, events } = makeAgent([{ text: 'answer' }])
    agent.submitUserMessage('question')
    const result = await agent.waitForCompletion()
    expect(result.status).toBe('completed')
    const msgs = entries.list('s1').filter((r) => r.entry.type === 'message')
    expect(msgs).toHaveLength(2) // user + assistant, no duplicates
    expect(events.filter((e) => e.kind === 'agent_end')).toHaveLength(1)
  })

  it('maps provider failure to agent_end failed and discards the pi agent', async () => {
    const { agent } = makeAgent([{ text: '', stopReason: 'error', errorMessage: 'boom' }])
    agent.submitUserMessage('q')
    const result = await agent.waitForCompletion()
    expect(result.status).toBe('failed')
  })

  it('coalesces message_update broadcasts to ≤1 per 40ms window', async () => {
    vi.useFakeTimers()
    try {
      const deltas = Array.from({ length: 10 }, (_, i) => `chunk${i}`)
      const message = fakeAssistantMessage(deltas.join(''))
      // Yields 10 text_delta events synchronously (before any real/fake timer
      // elapses) — without coalescing this would broadcast 10 message_update
      // events; the 40ms trailing-edge coalescer must collapse them to ≤1.
      const streamFn = () => streamOf(message, deltas)

      const entries = makeStore()
      const events: AgentWireEvent[] = []
      const agent = new SessionAgent({
        sessionId: 's1',
        entries,
        broadcast: (e) => events.push(e),
        acquireSlot: async () => () => {},
        buildAgentConfig: () => ({
          systemPrompt: 'test',
          model: FAKE_MODEL,
          thinkingLevel: 'off',
          tools: [],
          maxTurns: 5,
          streamFn,
        }),
        log: silentLogger(),
      })

      agent.submitUserMessage('question')
      await agent.waitForCompletion()
      // Flush any coalescing timer that might still be pending at run end.
      await vi.advanceTimersByTimeAsync(40)

      const updates = events.filter((e) => e.kind === 'message_update')
      expect(updates.length).toBeLessThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a prompt submitted mid-run is answered by a follow-up run, not dropped', async () => {
    const entries = makeStore()
    const events: AgentWireEvent[] = []
    let submittedB = false
    // `agent` is referenced inside `broadcast` before this statement finishes,
    // but the closure only runs later (once submitUserMessage triggers
    // events) — by then `agent` is fully initialized, so `const` is safe.
    const agent: SessionAgent = new SessionAgent({
      sessionId: 's1',
      entries,
      broadcast: (e) => {
        events.push(e)
        // Submit B the instant run 1's terminal event fires. message_end (which
        // persists the reply) always runs before agent_end within the same
        // continue() call, so by this point the reply is already in the entry
        // log — submitting here lands B in true trailing position for
        // runLoop's next hasUnansweredUserTail check, proving a message
        // submitted while the loop is still active (phase !== idle at the
        // point of submission, asserted below) triggers a genuine second run
        // rather than being dropped.
        if (e.kind === 'agent_end' && !submittedB) {
          submittedB = true
          expect(agent.phase).toBe('turn')
          agent.submitUserMessage('question B')
        }
      },
      acquireSlot: async () => () => {},
      buildAgentConfig: () => ({
        systemPrompt: 'test',
        model: FAKE_MODEL,
        thinkingLevel: 'off',
        tools: [],
        maxTurns: 5,
        streamFn: fakeStream([{ text: 'first answer' }, { text: 'second answer' }]),
      }),
      log: silentLogger(),
    })

    agent.submitUserMessage('question A')
    const result = await agent.waitForCompletion()

    expect(result.status).toBe('completed')
    expect(events.filter((e) => e.kind === 'agent_start')).toHaveLength(2)
    const msgs = entries.list('s1').filter((r) => r.entry.type === 'message')
    expect(msgs).toHaveLength(4) // A, first answer, B, second answer
  })

  it('cancel() while waiting for a slot resolves cancelled without an LLM call', async () => {
    let streamCalled = false
    const entries = makeStore()
    const agent = new SessionAgent({
      sessionId: 's1',
      entries,
      broadcast: () => {},
      // Never resolves on its own; only settles when cancel() aborts the signal.
      acquireSlot: (signal) =>
        new Promise<() => void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      buildAgentConfig: () => ({
        systemPrompt: 'test',
        model: FAKE_MODEL,
        thinkingLevel: 'off',
        tools: [],
        maxTurns: 5,
        streamFn: () => {
          streamCalled = true
          throw new Error('streamFn should never be called: cancel happened during slot wait')
        },
      }),
      log: silentLogger(),
    })

    agent.submitUserMessage('q')
    agent.cancel()
    const result = await agent.waitForCompletion()

    expect(result.status).toBe('cancelled')
    expect(streamCalled).toBe(false)
    const msgs = entries.list('s1').filter((r) => r.entry.type === 'message')
    expect(msgs).toHaveLength(1)
  })
})
