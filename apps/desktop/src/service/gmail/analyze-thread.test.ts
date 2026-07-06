// @vitest-environment node

import { emptyUsed } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import type { RunEmitInput } from '../run-engine/emit'
import { createRunEmit } from '../run-engine/emit'
import type { launchRun } from '../run-engine/launch'
import { type AnalyzeThreadDeps, createAnalyzeThread, parseThreadPayload } from './analyze-thread'

const fakeProvider = { id: 'p', model: 'm', apiKey: 'k' } as unknown as import('@swarm/protocol').ProviderInjection

// A fake launchRun that drives the real emit adapter: it feeds run.* wire events
// through createRunEmit (the same path the engine uses), so the analyze-thread
// module's broadcast port is exercised end-to-end.
function fakeLaunch(events: RunEmitInput[]): typeof launchRun {
  return (async (spec, ports) => {
    const emit = createRunEmit(ports.emit, { sessionId: spec.sessionId, runId: spec.runId ?? 'r' })
    for (const e of events) emit(e)
    return { runId: spec.runId ?? 'r', status: 'completed' as const, summary: 'ok', messages: [], used: emptyUsed() }
  }) as unknown as typeof launchRun
}

describe('parseThreadPayload', () => {
  it('parses a well-formed tail JSON block', () => {
    const md =
      '## 摘要\n要点一\n\n<!--ANALYSIS:{"summary":"一句话","todos":[{"t":"回复","due":true,"dueLabel":"今天"}],"suggest":"好的"}-->'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe('一句话')
    expect(out.todos).toEqual([{ t: '回复', due: true, dueLabel: '今天' }])
    expect(out.suggest).toBe('好的')
  })

  it('degrades gracefully when the tail JSON block is missing', () => {
    const md = '## 摘要\n要点一\n无尾部 JSON'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe(md) // summary falls back to the full markdown
    expect(out.todos).toEqual([])
    expect(out.suggest).toBe('')
  })

  it('degrades gracefully when the tail JSON is malformed', () => {
    const md = '## 摘要\n\n<!--ANALYSIS:{not valid json}-->'
    const out = parseThreadPayload(md)
    expect(out.todos).toEqual([])
    expect(out.suggest).toBe('')
    // summary is the full markdown (the malformed block stays in the streamed text)
    expect(out.summary).toContain('## 摘要')
  })

  it('uses the LAST tail JSON block if multiple appear', () => {
    const md =
      '<!--ANALYSIS:{"summary":"旧","todos":[],"suggest":""}-->\n\n更多内容\n\n<!--ANALYSIS:{"summary":"新","todos":[],"suggest":""}-->'
    const out = parseThreadPayload(md)
    expect(out.summary).toBe('新')
  })
})

describe('analyzeThread complete handler', () => {
  it('does NOT double the streamed summary when no tail-JSON block is present (regression)', async () => {
    // The run.complete summary is the trimmed echo of the streamed llm.message
    // deltas (per translator.ts). With no <!--ANALYSIS:{...}--> tail block, the
    // degradation path falls back to fullMarkdown as the summary. Appending
    // evt.summary to `accumulated` again would double it: "Hello summaryHello summary".
    const broadcasts: Array<[string, unknown]> = []
    const analyze = createAnalyzeThread({
      broadcaster: { broadcast: (e, d) => broadcasts.push([e, d]) } as AnalyzeThreadDeps['broadcaster'],
      agentStore: { get: () => undefined } as AnalyzeThreadDeps['agentStore'],
      toolRegistry: {} as AnalyzeThreadDeps['toolRegistry'],
      getBudgetConfig: () => ({}) as import('@swarm/protocol').BudgetConfig,
      launch: fakeLaunch([
        { kind: 'run.progress', event: { kind: 'llm.message', role: 'assistant', content: 'Hello summary', ts: 1 } },
        { kind: 'run.complete', summary: 'Hello summary' },
      ]),
    })

    const ack = analyze({
      threadId: 't1',
      subject: 's',
      messages: [{ from: 'a@b', dateMs: 0, bodyText: 'body' }],
      provider: fakeProvider,
    })

    expect(ack).toEqual({ ok: true })
    await new Promise((r) => setTimeout(r, 0))
    const complete = broadcasts.find(([e]) => e === 'gmail.threadAnalysisComplete')
    expect(complete).toBeDefined()
    // Must be the streamed text once — NOT doubled.
    expect((complete![1] as { summary: string }).summary).toBe('Hello summary')
    expect((complete![1] as { summary: string }).summary).not.toBe('Hello summaryHello summary')
    expect((complete![1] as { threadId: string }).threadId).toBe('t1')
  })
})
