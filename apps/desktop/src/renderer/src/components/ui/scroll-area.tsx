import type { Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'

import { cn } from '@/lib/utils'

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  /** Show top/bottom gradient edge fades when content overflows. */
  edgeFade?: boolean
  /** Ref to the scrolling viewport element, e.g. for `@tanstack/react-virtual`. */
  viewportRef?: Ref<HTMLDivElement>
  /**
   * Extra classes for the scrolling viewport. Apply a `max-h-*` here (NOT on the
   * root) to cap a ScrollArea whose parent has no definite height: the viewport
   * carries `overflow: scroll`, so a max-height on it makes content scroll,
   * whereas `max-h-*` on the root only clips — the viewport's `height: 100%`
   * can't resolve against an auto-height root, so it grows to full content.
   */
  viewportClassName?: string
}

function ScrollArea({
  className,
  children,
  edgeFade = false,
  viewportRef,
  viewportClassName,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root className={cn('group/scroll relative', className)} data-slot="scroll-area" {...props}>
      <ScrollAreaPrimitive.Viewport
        className={cn(
          'size-full rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50',
          viewportClassName
        )}
        data-slot="scroll-area-viewport"
        ref={viewportRef}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
      {edgeFade && (
        <>
          {/* Edge fade + backdrop blur. Content softens and blurs into the
              window-content background at each scroll edge. base-ui toggles
              data-overflow-y-start / -end on the root, so no JS scroll
              tracking is needed. The mask makes both the blur and the color
              fade taper together toward the content. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-9 opacity-0 transition-opacity duration-200 group-data-[overflow-y-start]/scroll:opacity-100"
            style={{
              background: 'linear-gradient(to bottom, var(--window-content), transparent)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              maskImage: 'linear-gradient(to bottom, #000, transparent)',
              WebkitMaskImage: 'linear-gradient(to bottom, #000, transparent)',
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-9 opacity-0 transition-opacity duration-200 group-data-[overflow-y-end]/scroll:opacity-100"
            style={{
              background: 'linear-gradient(to top, var(--window-content), transparent)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              maskImage: 'linear-gradient(to top, #000, transparent)',
              WebkitMaskImage: 'linear-gradient(to top, #000, transparent)',
            }}
          />
        </>
      )}
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({ className, orientation = 'vertical', ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        'flex touch-none select-none p-px transition-colors data-horizontal:h-2.5 data-vertical:h-full data-vertical:w-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:border-l data-vertical:border-l-transparent',
        className
      )}
      data-orientation={orientation}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" data-slot="scroll-area-thumb" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
