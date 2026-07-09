// apps/desktop/src/renderer/src/lib/palette/select-palette.test.ts
import { describe, expect, it } from 'vitest'

import { selectPalette } from './select-palette'
import type { PaletteItem } from './types'

const mk = (id: string, kind: PaletteItem['kind'], section?: string): PaletteItem => ({
  id,
  kind,
  title: id,
  section,
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
  it('mixed scope → groups by explicit `section` in first-seen order (design home)', () => {
    const items = [
      mk('r', 'taskRun', '继续未完成'),
      mk('c', 'command', '建议操作'),
      mk('s', 'chat', '最近对话'),
      mk('svc', 'service', '快捷入口'),
    ]
    const out = selectPalette('mixed', items)
    expect(out.sections.map((s) => s.heading)).toEqual(['继续未完成', '建议操作', '最近对话', '快捷入口'])
  })
  it('mixed scope → items sharing a section collapse into one group', () => {
    const items = [mk('a', 'taskRun', 'A'), mk('b', 'command', 'B'), mk('c', 'chat', 'A')]
    const out = selectPalette('mixed', items)
    expect(out.sections.map((s) => s.heading)).toEqual(['A', 'B'])
    // Flat order follows first-seen section order, items in arrival order within.
    expect(out.flat.map((i) => i.id)).toEqual(['a', 'c', 'b'])
  })
  it('mixed scope → items with no section fall back to 「其他」', () => {
    const out = selectPalette('mixed', [mk('x', 'command')])
    expect(out.sections[0].heading).toBe('其他')
  })
})
