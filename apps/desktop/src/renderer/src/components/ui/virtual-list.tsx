// Generic vertical virtualized list. Renders only the rows near the viewport so
// long lists (GitHub trending, sessions, Bilibili favorites) keep their DOM —
// and the memory their nodes/images hold — bounded regardless of item count.
//
// Built on the canonical ScrollArea (styled scrollbar is a project-wide
// convention) and `@tanstack/react-virtual`. Row heights are measured at
// runtime via `measureElement`, so callers don't need uniform-height rows;
// `estimateSize` only needs to be a rough average for the initial paint.
//
// `useVirtualList` + `<VirtualRows>` are shared with `StickToBottomList`, which
// composes the same virtualization and adds stick-to-bottom behavior.
import { useRef } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'

import { ScrollArea } from '@/components/ui/scroll-area'

// Concrete virtualizer type, matching what `useVirtualizer` infers from a div
// scroll element: TScrollElement = HTMLDivElement, TItemElement = Element (each
// measured row is a DOM Element). Keep both uses aligned on this alias so the
// hook's return and the component's prop can't drift apart.
type VirtualizerInstance = Virtualizer<HTMLDivElement, Element>

type VirtualListOptions<T> = {
  items: readonly T[]
  /** Stable identity per item — keeps measurement cache correct across reorders/filters. */
  getKey: (item: T, index: number) => string | number
  /** Rough average row height (px) for the first paint, before real measurement. */
  estimateSize?: number
  /** Rows rendered beyond each viewport edge. */
  overscan?: number
  /** Vertical gap between rows (px). */
  gap?: number
}

// Owns the scroll viewport ref and configures the virtualizer. Both VirtualList
// and StickToBottomList call this so the react-virtual wiring lives in one place.
export function useVirtualList<T>(opts: VirtualListOptions<T>): {
  viewportRef: React.RefObject<HTMLDivElement | null>
  virtualizer: VirtualizerInstance
} {
  const viewportRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: opts.items.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => opts.estimateSize ?? 80,
    getItemKey: (index) => opts.getKey(opts.items[index] as T, index),
    overscan: opts.overscan ?? 6,
    gap: opts.gap ?? 0,
  })

  return { viewportRef, virtualizer }
}

// Spacer whose height = total virtualized size, with each measured row absolutely
// positioned via translateY. Presentational; takes a configured virtualizer.
export function VirtualRows<T>({
  virtualizer,
  items,
  renderItem,
}: {
  virtualizer: VirtualizerInstance
  items: readonly T[]
  renderItem: (item: T, index: number) => React.ReactNode
}): React.JSX.Element {
  const virtualItems = virtualizer.getVirtualItems()

  return (
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
  )
}

type VirtualListProps<T> = VirtualListOptions<T> & {
  renderItem: (item: T, index: number) => React.ReactNode
  /** Class for the ScrollArea root — it owns the scroll height (e.g. "min-h-0 flex-1"). */
  className?: string
  /** Show top/bottom edge fades on the ScrollArea. */
  edgeFade?: boolean
}

export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimateSize,
  overscan,
  gap,
  className,
  edgeFade = false,
}: VirtualListProps<T>): React.JSX.Element {
  const { viewportRef, virtualizer } = useVirtualList({ items, getKey, estimateSize, overscan, gap })

  return (
    <ScrollArea className={className} edgeFade={edgeFade} viewportRef={viewportRef}>
      <VirtualRows items={items} renderItem={renderItem} virtualizer={virtualizer} />
    </ScrollArea>
  )
}
