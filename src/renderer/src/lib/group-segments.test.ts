import { describe, expect, it } from 'vitest'

import { groupSegments } from './group-segments'
import type { Segment } from './task-segments'

let n = 0
const tool = (name: string, extra: Partial<{ ok: boolean | null }> = {}): Segment =>
  ({
    kind: 'tool',
    tool: name,
    ok: true,
    input: {},
    output: null,
    key: `k${n++}`,
    taskId: 't',
    ts: n,
    ...extra,
  }) as Segment
const assistant = (): Segment => ({ kind: 'assistant', text: '', key: `k${n++}`, taskId: 't', ts: n })

describe('groupSegments', () => {
  it('keeps a lone tool as a single item', () => {
    const items = groupSegments([tool('read_file')])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('single')
  })

  it('groups consecutive tools into one group item', () => {
    const items = groupSegments([tool('read_file'), tool('write_file')])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('tools')
    if (items[0].kind === 'tools') expect(items[0].segs).toHaveLength(2)
  })

  it('keeps a run of three tools as a single group', () => {
    const items = groupSegments([tool('a'), tool('b'), tool('c')])
    expect(items.map((i) => i.kind)).toEqual(['tools'])
  })

  it('does not group tools separated by other segments', () => {
    const items = groupSegments([tool('a'), assistant(), tool('b')])
    expect(items.map((i) => i.kind)).toEqual(['single', 'single', 'single'])
  })

  it('breaks a run when a render_ui tool appears', () => {
    const items = groupSegments([tool('read_file'), tool('render_ui'), tool('write_file')])
    expect(items.map((i) => i.kind)).toEqual(['single', 'single', 'single'])
  })

  it('emits separate groups around non-tool segments', () => {
    const items = groupSegments([tool('a'), tool('b'), assistant(), tool('c'), tool('d'), tool('e')])
    expect(items.map((i) => i.kind)).toEqual(['tools', 'single', 'tools'])
  })
})
