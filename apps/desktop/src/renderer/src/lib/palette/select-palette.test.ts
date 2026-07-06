// apps/desktop/src/renderer/src/lib/palette/select-palette.test.ts
import { describe, expect, it } from 'vitest'

import { selectPalette } from './select-palette'
import type { PaletteItem } from './types'

const mk = (id: string, kind: PaletteItem['kind']): PaletteItem => ({
  id,
  kind,
  title: id,
  icon: 'Search',
  run: () => {},
  preview: { type: 'info', title: id, rows: [] },
  searchText: id,
})

describe('selectPalette', () => {
  it('command scope → single 「命令」 section', () => {
    const out = selectPalette('command', [mk('a', 'command'), mk('b', 'command')])
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0].heading).toBe('命令')
    expect(out.flat.map((i) => i.id)).toEqual(['a', 'b'])
  })
  it('agent scope → 「编队 & Agent · 回车即指派」', () => {
    const out = selectPalette('agent', [mk('a', 'agent')])
    expect(out.sections[0].heading).toBe('编队 & Agent · 回车即指派')
  })
  it('task scope → 「运行中」 then 「定时任务」 (empty sections dropped)', () => {
    const out = selectPalette('task', [mk('r1', 'taskRun'), mk('c1', 'taskSched'), mk('c2', 'taskSched')])
    expect(out.sections.map((s) => s.heading)).toEqual(['运行中', '定时任务'])
    expect(out.flat.map((i) => i.id)).toEqual(['r1', 'c1', 'c2'])
  })
  it('file scope → 「文件 & 产出」', () => {
    const out = selectPalette('file', [mk('f', 'file')])
    expect(out.sections[0].heading).toBe('文件 & 产出')
  })
  it('mixed scope → 「指派给 Agent」「命令」「对话」「文件 & 产出」「任务」「服务 · 记忆 · 技能」 (empty dropped)', () => {
    const items = [
      mk('d', 'dispatch'),
      mk('c', 'command'),
      mk('s', 'chat'),
      mk('f', 'file'),
      mk('r', 'taskRun'),
      mk('svc', 'service'),
      mk('m', 'memory'),
    ]
    const out = selectPalette('mixed', items)
    expect(out.sections.map((s) => s.heading)).toEqual([
      '指派给 Agent',
      '命令',
      '对话',
      '文件 & 产出',
      '任务',
      '服务 · 记忆 · 技能',
    ])
  })
  it('flat order matches section order', () => {
    const items = [mk('r', 'taskRun'), mk('d', 'dispatch')]
    const out = selectPalette('mixed', items)
    expect(out.flat.map((i) => i.id)).toEqual(['d', 'r'])
  })
})
