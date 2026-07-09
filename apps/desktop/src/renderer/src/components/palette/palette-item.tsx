// apps/desktop/src/renderer/src/components/palette/palette-item.tsx
// Renders a single row in the left column. The `icon` field on a PaletteItem
// is a lucide-react *name* string (kept pure in build-items.ts); this module
// owns the name → component table so the logic layer never imports React.

import { cn } from '@swarm/ui'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowRight,
  Brain,
  CalendarClock,
  CalendarPlus,
  ChevronRight,
  Command,
  Download,
  FileText,
  Flame,
  Folder,
  ListChecks,
  LoaderCircle,
  Mail,
  MessageSquare,
  Palette,
  PlayCircle,
  Plus,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Users,
  UsersRound,
} from 'lucide-react'

import type { PaletteItem } from '../../lib/palette/types'

/**
 * Name → lucide component map. Covers every `icon` string emitted by
 * `buildItems` PLUS the `SCOPE_META[scope].icon` names used by the input row
 * (`Command` / `Users` / `ListChecks` / `Folder` / `Search`). Unknown names
 * fall back to `Search` so a stray icon string never crashes the row.
 */
export const ICONS: Record<string, LucideIcon> = {
  // build-items.ts emitters
  Plus,
  CalendarPlus,
  UsersRound,
  Settings,
  Palette,
  Download,
  Users,
  MessageSquare,
  LoaderCircle,
  CalendarClock,
  PlayCircle,
  FileText,
  Brain,
  Sparkles,
  ArrowRight,
  Rocket,
  Mail,
  Flame,
  // SCOPE_META icons (input row)
  Command,
  ListChecks,
  Folder,
  Search,
}

const DEFAULT_ICON: LucideIcon = Search

/** Resolve a stored icon name to its component, falling back on a miss. */
export function resolveIcon(name: string): LucideIcon {
  return ICONS[name] ?? DEFAULT_ICON
}

export type PaletteItemRowProps = {
  item: PaletteItem
  /** Flat (across all sections) index of this row, for the active highlight. */
  flatIndex: number
  /** Currently-selected flat index in the parent list. */
  selIndex: number
  onSelect: (flatIndex: number) => void
  /** Fire the item's `run`. Called on click and (via the controller) Enter. */
  onRun: () => void
}

export function PaletteItemRow({ item, flatIndex, selIndex, onSelect, onRun }: PaletteItemRowProps): React.JSX.Element {
  const active = selIndex === flatIndex
  const Icon = resolveIcon(item.icon)
  const hasProgress = typeof item.progress === 'number'
  // Emphasize the icon tile for actionable/live rows (dispatch hero + resume
  // cards) with a primary tint; everything else stays neutral.
  const accent = item.kind === 'dispatch' || hasProgress
  return (
    <button
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors',
        'data-active:bg-accent data-active:text-accent-foreground'
      )}
      data-active={active}
      onClick={() => {
        onSelect(flatIndex)
        onRun()
      }}
      onMouseEnter={() => onSelect(flatIndex)}
      type="button"
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-[10px]',
          accent ? 'bg-primary/15 text-primary' : 'bg-muted/70 text-muted-foreground'
        )}
      >
        <Icon className="size-[18px]" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-[13px]">{item.title}</span>
        {item.subtitle ? <span className="truncate text-muted-foreground text-xs">{item.subtitle}</span> : null}
      </span>

      {item.badge ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.badge}</span>
      ) : null}
      {item.shortcut ? (
        <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {item.shortcut}
        </kbd>
      ) : null}
      {hasProgress ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="block h-1 w-14 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }}
            />
          </span>
          <ChevronRight className="size-4 text-muted-foreground/70" />
        </span>
      ) : null}
    </button>
  )
}
