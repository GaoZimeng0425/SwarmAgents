// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.test.ts

import type { MessageRecord } from '@shared/lib/apply-event'
import type { ArtifactEntry } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildArtifacts } from './build-artifacts'

function mkRun(over: Partial<MessageRecord> & Pick<MessageRecord, 'id'>): MessageRecord {
  return {
    sessionId: 's1',
    prompt: 'g',
    status: 'running',
    summary: null,
    createdAt: 1,
    attachments: [],
    order: 0,
    events: [],
    ...over,
  }
}

describe('buildArtifacts', () => {
  it('extracts absolute and relative file paths from tool_call args', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 1,
          ts: 1,
          tool: 'edit',
          args: { path: '/abs/report.md', label: 'a title' },
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 2,
          ts: 2,
          tool: 'edit',
          args: { file: './src/x.ts' },
        } as any,
      ],
    })
    const rows = buildArtifacts([run], [])
    expect(rows.map((r) => r.name)).toEqual(['report.md', 'x.ts'])
    expect(rows.every((r) => r.origin === 'session')).toBe(true)
  })

  it('extracts paths from array values too', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 1,
          ts: 1,
          tool: 'x',
          args: { files: ['/a.txt', './b.js', 'not a path'] },
        } as any,
      ],
    })
    expect(
      buildArtifacts([run], [])
        .map((r) => r.name)
        .sort()
    ).toEqual(['a.txt', 'b.js'])
  })

  it('ignores URLs and path-like strings without an extension', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 1,
          ts: 1,
          tool: 'x',
          args: { url: 'https://example.com/x', dir: '/etc' },
        } as any,
      ],
    })
    expect(buildArtifacts([run], [])).toEqual([])
  })

  it('deduplicates session paths by normalized form', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 1,
          ts: 1,
          tool: 'x',
          args: { a: '/tmp/./report.md', b: '/tmp/report.md' },
        } as any,
      ],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['report.md'])
  })

  it('includes bilibili artifacts from cwdArtifacts, tagged with their origin', () => {
    const cwdArtifacts: ArtifactEntry[] = [
      { kind: 'bilibili-analysis', name: 'BV1xx', ref: 'BV1xx', origin: 'Bilibili', modifiedAt: 40 },
    ]
    const rows = buildArtifacts([], cwdArtifacts)
    expect(rows.map((r) => r.name)).toEqual(['BV1xx'])
    expect(rows[0].origin).toBe('Bilibili')
  })

  it('session outputs come first, then bilibili artifacts', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'message.tool_call',
          sessionId: 's1',
          messageId: 'r1',
          order: 1,
          ts: 1,
          tool: 'x',
          args: { p: '/out/session.md' },
        } as any,
      ],
    })
    const cwdArtifacts: ArtifactEntry[] = [
      { kind: 'bilibili-analysis', name: 'BV1yy', ref: 'BV1yy', origin: 'Bilibili', modifiedAt: 100 },
    ]
    const rows = buildArtifacts([run], cwdArtifacts)
    expect(rows.map((r) => r.name)).toEqual(['session.md', 'BV1yy'])
  })

  it('returns empty when neither source has anything', () => {
    expect(buildArtifacts([], [])).toEqual([])
  })
})
