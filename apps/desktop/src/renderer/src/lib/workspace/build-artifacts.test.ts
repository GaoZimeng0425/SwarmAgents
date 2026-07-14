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

// Build a message.progress event wrapping a tool.call TaskEvent.
function toolCall(tool: string, args: unknown, seq: number, ts = seq): MessageRecord['events'][number] {
  return {
    kind: 'message.progress',
    sessionId: 's1',
    messageId: 'r1',
    seq,
    ts,
    event: { kind: 'tool.call', server: 'agent', tool, args, ts },
  } as MessageRecord['events'][number]
}

describe('buildArtifacts', () => {
  it('extracts path from write_file args', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('write_file', { path: '/abs/report.md', content: 'x' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['report.md'])
  })

  it('extracts path from edit_file args', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('edit_file', { path: '/src/x.ts', old_string: 'a', new_string: 'b' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['x.ts'])
  })

  it('extracts redirect targets from run_shell', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('run_shell', { command: 'echo hi > out.txt' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['out.txt'])
  })

  it('extracts append-redirect targets from run_shell', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('run_shell', { command: 'cat a >> log.txt' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['log.txt'])
  })

  it('extracts cp destination from run_shell', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('run_shell', { command: 'cp src.ts dist/main.js' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['main.js'])
  })

  it('extracts tee target from run_shell', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('run_shell', { command: 'echo hi | tee config.json' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['config.json'])
  })

  it('resolves relative shell targets against cwd', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('run_shell', { command: 'echo hi > ./out/result.txt' }, 1)],
    })
    const rows = buildArtifacts([run], [], '/home/user/proj')
    expect(rows[0].ref).toBe('/home/user/proj/out/result.txt')
  })

  it('extracts paths from MCP tools via heuristic', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('some_mcp_tool', { file_path: '/abs/report.md', label: 'a title' }, 1)],
    })
    expect(buildArtifacts([run], []).map((r) => r.name)).toEqual(['report.md'])
    expect(rowsOrigin(buildArtifacts([run], []))).toEqual(['session'])
  })

  it('extracts paths from array values in MCP tool args', () => {
    const run = mkRun({
      id: 'r1',
      events: [toolCall('x', { files: ['/a.txt', './b.js', 'not a path'] }, 1)],
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
      events: [toolCall('x', { url: 'https://example.com/x', dir: '/etc' }, 1)],
    })
    expect(buildArtifacts([run], [])).toEqual([])
  })

  it('deduplicates session paths by normalized form', () => {
    const run = mkRun({
      id: 'r1',
      events: [
        toolCall('write_file', { path: '/tmp/./report.md', content: 'a' }, 1),
        toolCall('edit_file', { path: '/tmp/report.md', old_string: 'a', new_string: 'b' }, 2),
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
      events: [toolCall('write_file', { path: '/out/session.md', content: 'x' }, 1)],
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

function rowsOrigin(rows: ReturnType<typeof buildArtifacts>): string[] {
  return rows.map((r) => r.origin)
}
