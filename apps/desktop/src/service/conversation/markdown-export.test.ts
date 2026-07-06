import type { RunEvent, TaskEvent, UIEvent } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildMarkdown } from './markdown-export'

// A RunEvent row whose event is a run.* wire event. The markdown builder reads
// the session's RunEvent stream (UIEvent-shaped); messages/tools/errors live
// inside run.progress events as TaskEvent payloads.
const runRow = (runId: string, event: UIEvent, parentRunId: string | null = null): RunEvent => ({
  runId,
  parentRunId,
  seq: 1,
  ts: 1000,
  event,
})

// A run.progress event wrapping a TaskEvent (the actual transcript content).
const progress = (runId: string, taskEvent: TaskEvent): RunEvent =>
  runRow(runId, {
    kind: 'run.progress',
    sessionId: 's',
    runId,
    seq: 1,
    ts: 1000,
    event: taskEvent,
  })

const created = (runId: string, goal: string, parentRunId?: string): RunEvent =>
  runRow(
    runId,
    {
      kind: 'run.created',
      sessionId: 's',
      runId,
      seq: 1,
      ts: 1,
      goal,
    },
    parentRunId ?? null
  )

describe('buildMarkdown', () => {
  it('renders an assistant message as a bold Agent line', () => {
    const out = buildMarkdown([
      created('r1', 'g'),
      progress('r1', { kind: 'llm.message', role: 'assistant', content: 'Hello there.', ts: 1 }),
    ])
    expect(out).toContain('**Agent:**')
    expect(out).toContain('Hello there.')
  })

  it('renders a user message as a bold You line', () => {
    const out = buildMarkdown([
      created('r1', 'g'),
      progress('r1', { kind: 'llm.message', role: 'user', content: 'Do the thing.', ts: 1 }),
    ])
    expect(out).toContain('**You:**')
    expect(out).toContain('Do the thing.')
  })

  it('renders a tool call as a fenced code block with the tool name', () => {
    const out = buildMarkdown([
      created('r1', 'g'),
      progress('r1', { kind: 'tool.call', server: 'fs', tool: 'read_file', args: { path: '/a' }, ts: 1 }),
    ])
    expect(out).toContain('```')
    expect(out).toContain('read_file')
  })

  it('renders a run.error as a blockquote', () => {
    const out = buildMarkdown([
      created('r1', 'g'),
      runRow('r1', {
        kind: 'run.error',
        sessionId: 's',
        runId: 'r1',
        seq: 2,
        ts: 2,
        error: { code: 'boom', message: 'it broke', tier: 'recoverable' },
      }),
    ])
    expect(out).toContain('> ')
    expect(out).toContain('it broke')
  })

  it('skips reasoning events (private to the model)', () => {
    const out = buildMarkdown([
      created('r1', 'g'),
      progress('r1', { kind: 'reasoning', content: 'thinking secretly', ts: 1 }),
      progress('r1', { kind: 'llm.message', role: 'assistant', content: 'visible', ts: 2 }),
    ])
    expect(out).not.toContain('thinking secretly')
    expect(out).toContain('visible')
  })

  it('truncates large payloads (>2KB) with a marker', () => {
    const big = 'x'.repeat(3000)
    const out = buildMarkdown([
      created('r1', 'g'),
      progress('r1', { kind: 'llm.message', role: 'assistant', content: big, ts: 1 }),
    ])
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(big.length)
  })

  it('nests child runs under their parent with indentation', () => {
    const out = buildMarkdown([
      created('parent', 'parent goal'),
      created('child', 'child goal', 'parent'),
      progress('child', { kind: 'llm.message', role: 'assistant', content: 'child body', ts: 1 }),
    ])
    expect(out).toContain('parent goal')
    expect(out).toContain('child goal')
    expect(out).toContain('child body')
  })

  it('returns a header-only doc for empty input', () => {
    const out = buildMarkdown([])
    expect(out).toMatch(/SwarmAgents|Session|Export/i)
    expect(out.trim().length).toBeGreaterThan(0)
  })
})
