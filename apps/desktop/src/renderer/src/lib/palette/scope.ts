// apps/desktop/src/renderer/src/lib/palette/scope.ts
// Pure scope parser for the ⌘K command palette input row.

// Inline the union here; Task 2 promotes it to types.ts and this file re-exports.
export type PaletteScope = 'command' | 'agent' | 'task' | 'file' | 'mixed'

export type ScopeMeta = {
  /** Chinese pill label, or null for mixed (no pill rendered). */
  pill: string | null
  /** Tailwind text-color class applied to icon, pill, and input caret accent. */
  color: string
  /** Placeholder shown in the input when term is empty. */
  placeholder: string
  /** lucide-react icon name component (resolved in the React layer, not here). */
  icon: 'Command' | 'Users' | 'ListChecks' | 'Folder' | 'Search'
}

export const SCOPE_META: Record<PaletteScope, ScopeMeta> = {
  command: { pill: '命令', color: 'text-primary', placeholder: '运行命令…', icon: 'Command' },
  agent: { pill: '指派', color: 'text-indigo-500', placeholder: '选择编队或 Agent…', icon: 'Users' },
  task: { pill: '任务', color: 'text-orange-500', placeholder: '查找运行中 / 定时任务…', icon: 'ListChecks' },
  file: { pill: '文件', color: 'text-emerald-500', placeholder: '查找 Agent 产出的文件…', icon: 'Folder' },
  mixed: {
    pill: null,
    color: 'text-indigo-500',
    placeholder: '搜索、输入命令,或直接把目标交给 Agent…',
    icon: 'Search',
  },
}

const PREFIX_TO_MODE: Record<string, PaletteScope> = {
  '>': 'command',
  '@': 'agent',
  '#': 'task',
  '/': 'file',
}

/** Parse the raw input into a scope mode + the remaining search term. */
export function getScope(query: string): { mode: PaletteScope; term: string } {
  const trimmed = query.trimStart()
  const first = trimmed[0] ?? ''
  const mode = PREFIX_TO_MODE[first] ?? 'mixed'
  const term = mode === 'mixed' ? trimmed.trim() : trimmed.slice(1).trim()
  return { mode, term }
}
