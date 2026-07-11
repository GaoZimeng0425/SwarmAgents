// @vitest-environment node

import { emptyUsed } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { createMessageEmit } from '../message-engine/emit'
import type { launchMessage } from '../message-engine/launch'
import { createAnalyzeEmail } from './analyze'

const fakeProvider = { id: 'p', model: 'm', apiKey: 'k' } as unknown as import('@swarm/protocol').ProviderInjection

// A fake launchMessage that drives the real emit adapter: it feeds message.* wire events
// through createMessageEmit (the same path the engine uses), so the analyze module's
// broadcast port is exercised end-to-end.
function fakeLaunch(events: import('../message-engine/emit').MessageEmitInput[]): typeof launchMessage {
  return (async (spec, ports) => {
    const emit = createMessageEmit(ports.emit, { sessionId: spec.sessionId, messageId: spec.messageId ?? 'r' })
    for (const e of events) emit(e)
    return {
      messageId: spec.messageId ?? 'r',
      status: 'completed' as const,
      summary: 'ok',
      messages: [],
      used: emptyUsed(),
    }
  }) as unknown as typeof launchMessage
}

type Deps = Parameters<typeof createAnalyzeEmail>[0]

describe('analyzeEmail', () => {
  it('streams deltas then complete, and returns an ack immediately', async () => {
    const broadcasts: Array<[string, unknown]> = []
    const analyze = createAnalyzeEmail({
      broadcaster: { broadcast: (e, d) => broadcasts.push([e, d]) } as Deps['broadcaster'],
      agentStore: { get: () => undefined } as Deps['agentStore'],
      toolRegistry: {} as Deps['toolRegistry'],
      getBudgetConfig: () => ({}) as import('@swarm/protocol').BudgetConfig,
      launch: fakeLaunch([
        { kind: 'message.progress', event: { kind: 'llm.message', role: 'assistant', content: '## 摘要\n', ts: 1 } },
        { kind: 'message.progress', event: { kind: 'llm.message', role: 'assistant', content: '测试', ts: 2 } },
        { kind: 'message.complete', summary: '## 摘要\n测试' },
      ]),
    })

    const ack = analyze({ messageId: 'm1', subject: 's', from: 'a@b', content: 'body', provider: fakeProvider })

    expect(ack).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 0))
    const deltas = broadcasts.filter(([e]) => e === 'gmail.analysisDelta')
    expect(deltas.map(([, d]) => (d as { text: string }).text)).toEqual(['## 摘要\n', '测试'])
    const complete = broadcasts.find(([e]) => e === 'gmail.analysisComplete')
    expect((complete![1] as { markdown: string }).markdown).toBe('## 摘要\n测试')
    expect((complete![1] as { messageId: string }).messageId).toBe('m1')
  })

  it('translates a run.error terminal into gmail.analysisError', async () => {
    const broadcasts: Array<[string, unknown]> = []
    const analyze = createAnalyzeEmail({
      broadcaster: { broadcast: (e, d) => broadcasts.push([e, d]) } as Deps['broadcaster'],
      agentStore: { get: () => undefined } as Deps['agentStore'],
      toolRegistry: {} as Deps['toolRegistry'],
      getBudgetConfig: () => ({}) as import('@swarm/protocol').BudgetConfig,
      launch: fakeLaunch([
        { kind: 'message.error', error: { code: 'agent_exception', message: 'boom', tier: 'fatal' } },
      ]),
    })

    analyze({ messageId: 'm2', subject: 's', from: 'a@b', content: 'body', provider: fakeProvider })
    await new Promise((r) => setTimeout(r, 0))
    const err = broadcasts.find(([e]) => e === 'gmail.analysisError')
    expect(err).toBeDefined()
    expect((err![1] as { error: string }).error).toBe('boom')
    expect((err![1] as { messageId: string }).messageId).toBe('m2')
  })

  it('returns no_provider when the provider is missing', () => {
    const analyze = createAnalyzeEmail({
      broadcaster: { broadcast: () => undefined } as Deps['broadcaster'],
      agentStore: { get: () => undefined } as Deps['agentStore'],
      toolRegistry: {} as Deps['toolRegistry'],
      getBudgetConfig: () => ({}) as import('@swarm/protocol').BudgetConfig,
    })
    const r = analyze({ messageId: 'm1', subject: '', from: '', content: '', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})
