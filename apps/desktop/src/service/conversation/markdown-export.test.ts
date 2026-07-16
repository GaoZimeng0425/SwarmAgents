import type { EntryRow, SessionEntry } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildMarkdown } from './markdown-export'

let rowId = 0
const row = (entry: SessionEntry): EntryRow => ({ rowId: ++rowId, entry })

// A 'message' entry whose message is an opaque pi AgentMessage.
const msg = (message: unknown): EntryRow =>
  row({ type: 'message', id: `m${rowId}`, parentId: null, timestamp: '', message } as SessionEntry)

const custom = (customType: string, data: unknown): EntryRow =>
  row({ type: 'custom', customType, id: `c${rowId}`, parentId: null, timestamp: '', data } as SessionEntry)

describe('buildMarkdown', () => {
  it('renders an assistant message as a bold Agent line', () => {
    const out = buildMarkdown([msg({ role: 'user', content: 'g' }), msg({ role: 'assistant', content: 'Hello there.' })])
    expect(out).toContain('**Agent:**')
    expect(out).toContain('Hello there.')
  })

  it('renders a user message as a section heading', () => {
    const out = buildMarkdown([msg({ role: 'user', content: 'Do the thing.' })])
    expect(out).toContain('## Do the thing.')
  })

  it('renders text from an array-content assistant message', () => {
    const out = buildMarkdown([msg({ role: 'assistant', content: [{ type: 'text', text: 'visible' }] })])
    expect(out).toContain('visible')
  })

  it('renders a tool call as a fenced code block with the tool name', () => {
    const out = buildMarkdown([
      msg({ role: 'assistant', content: [{ type: 'tool_use', name: 'read_file', input: { path: '/a' } }] }),
    ])
    expect(out).toContain('```')
    expect(out).toContain('read_file')
  })

  it('renders a plan custom entry as a checklist', () => {
    const out = buildMarkdown([
      custom('plan', {
        todos: [
          { content: 'first', status: 'completed' },
          { content: 'second', status: 'pending' },
        ],
      }),
    ])
    expect(out).toContain('- [x] first')
    expect(out).toContain('- [ ] second')
  })

  it('skips usage custom entries (app-data, not transcript)', () => {
    const out = buildMarkdown([custom('usage', { runId: 'r', used: { tokens: 5 } })])
    expect(out).not.toContain('tokens')
    expect(out).not.toContain('runId')
  })

  it('skips tool-result messages (noise in an export)', () => {
    const out = buildMarkdown([msg({ role: 'tool', content: [{ type: 'tool_result', content: 'x' }] })])
    // Header only — no transcript body from a tool result.
    expect(out).not.toContain('tool_result')
  })

  it('truncates large payloads (>2KB) with a marker', () => {
    const big = 'x'.repeat(3000)
    const out = buildMarkdown([msg({ role: 'assistant', content: big })])
    expect(out).toContain('truncated')
    expect(out.length).toBeLessThan(big.length)
  })

  it('returns a header-only doc for empty input', () => {
    const out = buildMarkdown([])
    expect(out).toMatch(/SwarmAgents|Session|Export/i)
    expect(out.trim().length).toBeGreaterThan(0)
  })
})
