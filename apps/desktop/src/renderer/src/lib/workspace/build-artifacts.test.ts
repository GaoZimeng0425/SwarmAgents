// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.test.ts

import type { RunRecord } from '@shared/lib/apply-event'
import type { ArtifactEntry } from '@swarm/protocol'
import { describe, expect, it } from 'vitest'

import { buildArtifacts } from './build-artifacts'

function mkRun(over: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord {
  return {
    sessionId: 's1',
    goal: 'g',
    status: 'running',
    summary: null,
    startedAt: 1,
    attachments: [],
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
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 1,
          ts: 1,
          tool: 'edit',
          args: { path: '/abs/report.md', label: 'a title' },
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 2,
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
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 1,
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
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 1,
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
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 1,
          ts: 1,
          tool: 'x',
          args: { a: '/tmp/./report.md', b: '/tmp/report.md' },
        } as any,
      ],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['report.md'])
  })

  it('merges cwd artifacts, tagged with their origin', () => {
    const cwd: ArtifactEntry[] = [
      { kind: 'file', name: 'notes.md', ref: '/cwd/notes.md', origin: '/cwd', modifiedAt: 50 },
      { kind: 'bilibili-analysis', name: 'BV1xx', ref: 'BV1xx', origin: 'Bilibili', modifiedAt: 40 },
    ]
    const rows = buildArtifacts([], cwd)
    expect(rows.map((r) => r.name)).toEqual(['notes.md', 'BV1xx'])
    expect(rows[0].origin).toBe('/cwd')
    expect(rows[1].origin).toBe('Bilibili')
  })

  it('session outputs come first, then cwd recents', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 1,
          ts: 1,
          tool: 'x',
          args: { p: '/out/session.md' },
        } as any,
      ],
    })
    const cwd: ArtifactEntry[] = [
      { kind: 'file', name: 'cwd-file.md', ref: '/cwd/cwd-file.md', origin: '/cwd', modifiedAt: 100 },
    ]
    const rows = buildArtifacts([run], cwd)
    expect(rows.map((r) => r.name)).toEqual(['session.md', 'cwd-file.md'])
  })

  it('deduplicates across sources (session wins)', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        {
          kind: 'run.tool_call',
          sessionId: 's1',
          runId: 'r1',
          seq: 1,
          ts: 1,
          tool: 'x',
          args: { p: '/shared/dup.md' },
        } as any,
      ],
    })
    const cwd: ArtifactEntry[] = [
      { kind: 'file', name: 'dup.md', ref: '/shared/dup.md', origin: '/shared', modifiedAt: 1 },
    ]
    const rows = buildArtifacts([run], cwd)
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('session')
  })

  it('returns empty when neither source has anything', () => {
    expect(buildArtifacts([], [])).toEqual([])
  })
})
