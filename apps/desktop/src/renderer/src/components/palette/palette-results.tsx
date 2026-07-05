// apps/desktop/src/renderer/src/components/palette/palette-results.tsx
// Left column: grouped sections of PaletteItemRows. The flat selection index
// is computed across all sections so ↑/↓ in usePaletteState walks every row
// regardless of section boundaries.
import { cn } from '@swarm/ui'

import type { PaletteItem, PaletteScope, PaletteSection } from '../../lib/palette/types'
import { PaletteItemRow } from './palette-item'

export type PaletteResultsProps = {
  sections: PaletteSection[]
  scope: PaletteScope
  /** Already-flattened item list, parallel to the flat selection index. */
  flat: PaletteItem[]
  selIndex: number
  onSetSelIndex: (flatIndex: number) => void
  /** Raw query (original case) for the empty-state message. */
  query: string
  /** Wrapper sizing/layout (e.g. `flex-1` from the parent flex row). */
  className?: string
}

export function PaletteResults({
  sections,
  flat,
  selIndex,
  onSetSelIndex,
  query,
  className,
}: PaletteResultsProps): React.JSX.Element {
  // Empty state: nothing matched (or no home rows to show).
  if (flat.length === 0) {
    return (
      <div
        className={cn(
          'cmdscroll flex h-full items-center justify-center overflow-y-auto p-8 text-center text-muted-foreground text-sm',
          className
        )}
      >
        <span>
          没有匹配「<span className="text-foreground">{query || ' '}</span>」的结果
        </span>
      </div>
    )
  }

  // Walk sections in order, accumulating a flat offset so each row knows its
  // global index for the active highlight + selection.
  let flatOffset = 0
  return (
    <div className={cn('cmdscroll h-full overflow-y-auto px-2 py-2', className)}>
      {sections.map((section) => {
        const rows = section.items.map((item, i) => {
          const flatIndex = flatOffset + i
          return (
            <PaletteItemRow
              flatIndex={flatIndex}
              item={item}
              key={item.id}
              onRun={() => flat[flatIndex]?.run()}
              onSelect={onSetSelIndex}
              selIndex={selIndex}
            />
          )
        })
        flatOffset += section.items.length
        return (
          <section className="mb-1.5 last:mb-0" key={section.heading}>
            <h3 className={cn('px-2.5 pt-2 pb-1 font-medium text-[11px] text-muted-foreground tracking-wide')}>
              {section.heading}
            </h3>
            <div className="flex flex-col gap-0.5">{rows}</div>
          </section>
        )
      })}
    </div>
  )
}
