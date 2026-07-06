// apps/desktop/src/renderer/src/lib/palette/types.ts
// Shared domain types for the ⌘K command palette.

// Re-exported here so downstream modules import from a single barrel.
export type PaletteScope = 'command' | 'agent' | 'task' | 'file' | 'mixed'

/**
 * Discriminator for both the left-row rendering and the right preview pane.
 * - `dispatch` is the mixed-mode hero "把这个目标交给 Agent" item.
 * - `info` is the generic preview fallback (command/agent/file/service/memory/skill).
 */
export type PaletteItemKind =
  | 'command'
  | 'agent'
  | 'chat'
  | 'taskRun'
  | 'taskSched'
  | 'file'
  | 'service'
  | 'memory'
  | 'skill'
  | 'dispatch'

/**
 * One selectable row in the left column. `kind` drives icon/color/preview;
 * `run()` is invoked on Enter; `preview` carries the data the right pane needs.
 */
export type PaletteItem = {
  id: string
  kind: PaletteItemKind
  /** Primary row title. */
  title: string
  /** Secondary row subtitle (path, agent, cron, etc.). */
  subtitle?: string
  /** Optional trailing badge (status, role, etc.). */
  badge?: string
  /** Optional 0..1 progress for running tasks. */
  progress?: number
  /** lucide icon name; resolved to a component in the React layer. */
  icon: string
  /** Run on Enter or click. Returns void; navigation/side-effects happen inside. */
  run: () => void
  /** Right-pane preview payload; shape depends on `kind`. */
  preview: PreviewData
  /** Lowercased string used by the pure filter. Usually `${title} ${subtitle ?? ''}`. */
  searchText: string
}

/** Discriminated preview payload. `kind` on the item selects which preview renders. */
export type PreviewData =
  | { type: 'dispatch'; term: string; formations: { id: string; label: string }[] }
  | { type: 'chat'; sessionId: string; title: string }
  | {
      type: 'taskRun'
      run: {
        id: string
        goal: string
        summary: string | null
        status: string
        plan?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
      }
      /** Session the run belongs to; used to fetch the live log via getRunEvents. */
      sessionId: string
    }
  | {
      type: 'taskSched'
      task: {
        id: string
        name: string | null
        cron: string
        nextRun: number | null
        lastRun: number | null
        lastStatus: string | null
        sessionId: string
      }
    }
  | { type: 'info'; title: string; desc?: string; rows: { label: string; value: string }[] }

/** A grouped section in the left column. */
export type PaletteSection = {
  /** Chinese heading (e.g. 「命令」, 「运行中」). */
  heading: string
  items: PaletteItem[]
}
