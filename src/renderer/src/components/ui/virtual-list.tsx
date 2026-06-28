// Generic vertical virtualized list. Renders only the rows near the viewport so
// long lists (GitHub trending, sessions, Bilibili favorites) keep their DOM —
// and the memory their nodes/images hold — bounded regardless of item count.
//
// Built on the canonical ScrollArea (styled scrollbar is a project-wide
// convention) and `@tanstack/react-virtual`. Row heights are measured at
// runtime via `measureElement`, so callers don't need uniform-height rows;
// `estimateSize` only needs to be a rough average for the initial paint.
import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { ScrollArea } from "@/components/ui/scroll-area"

type VirtualListProps<T> = {
  items: readonly T[]
  /** Stable identity per item — keeps measurement cache correct across reorders/filters. */
  getKey: (item: T, index: number) => string | number
  renderItem: (item: T, index: number) => React.ReactNode
  /** Rough average row height (px) for the first paint, before real measurement. */
  estimateSize?: number
  /** Rows rendered beyond each viewport edge. */
  overscan?: number
  /** Vertical gap between rows (px). */
  gap?: number
  /** Class for the ScrollArea root — it owns the scroll height (e.g. "min-h-0 flex-1"). */
  className?: string
  /** Show top/bottom edge fades on the ScrollArea. */
  edgeFade?: boolean
}

export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimateSize = 80,
  overscan = 6,
  gap = 0,
  className,
  edgeFade = false,
}: VirtualListProps<T>): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => getKey(items[index] as T, index),
    overscan,
    gap,
  })

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <ScrollArea className={className} edgeFade={edgeFade} viewportRef={viewportRef}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index]
          if (item === undefined) return null
          return (
            <div
              className="absolute top-0 left-0 w-full"
              data-index={virtualRow.index}
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
