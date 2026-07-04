// @vitest-environment node

import { emptyUsed } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import type { AgentRunnerDeps, createAgentRunner } from '../session/agent-runner'
import { createAnalyzeEmail } from './analyze'

const fakeProvider = { id: 'p', model: 'm' } as unknown as import('@swarm/protocol').ProviderInjection

function fakeRunner(events: { event: string; data: unknown }[]): typeof createAgentRunner {
  return ((deps: AgentRunnerDeps) => ({
    run: async () => {
      for (const e of events) deps.emit(e.event, e.data)
      return { status: 'completed' as const, summary: '## 摘要\n测试', messages: [], used: emptyUsed() }
    },
  })) as unknown as typeof createAgentRunner
}

type Deps = Parameters<typeof createAnalyzeEmail>[0]
const zero = { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 }

describe('analyzeEmail', () => {
  it('streams deltas then complete, and returns an ack immediately', async () => {
    const broadcasts: Array<[string, unknown]> = []
    const analyze = createAnalyzeEmail({
      broadcaster: { broadcast: (e, d) => broadcasts.push([e, d]) } as Deps['broadcaster'],
      agentStore: { get: () => undefined } as Deps['agentStore'],
      toolRegistry: {} as Deps['toolRegistry'],
      getBudgetConfig: () => ({ main: zero, sub: zero }) as import('@swarm/protocol').BudgetConfig,
      createRunner: fakeRunner([
        {
          event: 'task.progress',
          data: { taskId: 'm1', event: { kind: 'llm.message', role: 'assistant', content: '## 摘要\n', ts: 1 } },
        },
        {
          event: 'task.progress',
          data: { taskId: 'm1', event: { kind: 'llm.message', role: 'assistant', content: '测试', ts: 2 } },
        },
        { event: 'task.complete', data: { taskId: 'm1', summary: '## 摘要\n测试', ts: 3 } },
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

  it('returns no_provider when the provider is missing', () => {
    const analyze = createAnalyzeEmail({
      broadcaster: { broadcast: () => undefined } as Deps['broadcaster'],
      agentStore: { get: () => undefined } as Deps['agentStore'],
      toolRegistry: {} as Deps['toolRegistry'],
      getBudgetConfig: () => ({ main: zero, sub: zero }) as import('@swarm/protocol').BudgetConfig,
    })
    const r = analyze({ messageId: 'm1', subject: '', from: '', content: '', provider: undefined as never })
    expect(r).toEqual({ ok: false, code: 'no_provider', message: expect.any(String) })
  })
})
