// apps/desktop/src/renderer/src/lib/palette/select-palette.ts
import type { PaletteItem, PaletteScope, PaletteSection } from './types'

type GroupDef = { heading: string; kinds: PaletteItem['kind'][] }

// Kind-based grouping for the prefix scopes. The mixed scope groups by each
// item's explicit `section` instead (see selectPalette), so it's absent here.
const GROUPS: Record<Exclude<PaletteScope, 'mixed'>, GroupDef[]> = {
  command: [{ heading: '命令', kinds: ['command'] }],
  agent: [{ heading: '编队 & Agent · 回车即指派', kinds: ['agent'] }],
  task: [
    { heading: '运行中', kinds: ['taskRun'] },
    { heading: '定时任务', kinds: ['taskSched'] },
  ],
  file: [{ heading: '文件 & 产出', kinds: ['file'] }],
}

export function selectPalette(
  scope: PaletteScope,
  items: PaletteItem[]
): { sections: PaletteSection[]; flat: PaletteItem[] } {
  // Mixed scope: build-items tags each row with an explicit `section` (the
  // design's 继续未完成 / 建议操作 / … headings), so group by that in first-seen
  // order rather than the rigid kind→heading table below.
  if (scope === 'mixed') {
    const order: string[] = []
    const bucket = new Map<string, PaletteItem[]>()
    for (const item of items) {
      const heading = item.section ?? '其他'
      if (!bucket.has(heading)) {
        bucket.set(heading, [])
        order.push(heading)
      }
      bucket.get(heading)!.push(item)
    }
    const sections = order.map((heading) => ({ heading, items: bucket.get(heading)! }))
    return { sections, flat: sections.flatMap((s) => s.items) }
  }

  const sections = GROUPS[scope]
    .map((g) => ({ heading: g.heading, items: items.filter((i) => g.kinds.includes(i.kind)) }))
    .filter((s) => s.items.length > 0)
  return { sections, flat: sections.flatMap((s) => s.items) }
}
