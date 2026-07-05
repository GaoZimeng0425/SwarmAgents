// apps/desktop/src/renderer/src/lib/palette/select-palette.ts
import type { PaletteItem, PaletteScope, PaletteSection } from './types'

type GroupDef = { heading: string; kinds: PaletteItem['kind'][] }

const GROUPS: Record<PaletteScope, GroupDef[]> = {
  command: [{ heading: '命令', kinds: ['command'] }],
  agent: [{ heading: '编队 & Agent · 回车即指派', kinds: ['agent'] }],
  task: [
    { heading: '运行中', kinds: ['taskRun'] },
    { heading: '定时任务', kinds: ['taskSched'] },
  ],
  file: [{ heading: '文件 & 产出', kinds: ['file'] }],
  mixed: [
    { heading: '指派给 Agent', kinds: ['dispatch'] },
    { heading: '命令', kinds: ['command'] },
    { heading: '对话', kinds: ['chat'] },
    { heading: '文件 & 产出', kinds: ['file'] },
    { heading: '任务', kinds: ['taskRun', 'taskSched'] },
    { heading: '服务 · 记忆 · 技能', kinds: ['service', 'memory', 'skill'] },
  ],
}

export function selectPalette(
  scope: PaletteScope,
  items: PaletteItem[]
): { sections: PaletteSection[]; flat: PaletteItem[] } {
  const sections = GROUPS[scope]
    .map((g) => ({ heading: g.heading, items: items.filter((i) => g.kinds.includes(i.kind)) }))
    .filter((s) => s.items.length > 0)
  return { sections, flat: sections.flatMap((s) => s.items) }
}
