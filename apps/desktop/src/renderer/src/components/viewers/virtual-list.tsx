// Virtualized message list that stays pinned to the bottom while new content
// streams in — the chat/transcript UX.
//
// Why hand-rolled native scroller (not base-ui ScrollArea): react-virtual and
// base-ui ScrollArea both observe the scroll element — react-virtual reads
// `offsetHeight` via its own ResizeObserver (virtual-core observeElementRect),
// base-ui's ScrollAreaViewport mounts a second ResizeObserver that drives Root-
// level setState (computeThumbPosition → setThumbSize/setHiddenState). With no
// master, the two state machines race: rows measure as 0 while getTotalSize is
// non-zero. This component gives react-virtual sole ownership of a plain native
// scroller (.cmdscroll), so there is no competing measurer.
//
// Stick-to-bottom subscribes to react-virtual's getTotalSize() (the single
// source of truth for content height under virtualization) rather than a
// ResizeObserver on a content element — the old non-virtualized list could
// observe real DOM height because every row was mounted; here only the visible
// window is.
import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { cn } from '@/lib/utils'

// `useStickToBottom` is exported for direct unit testing of its state machine.
// It reads/writes the scroll element's geometry directly; in jsdom those are 0,
// so tests mock scrollHeight/clientHeight/scrollTop on the element instance.
export function useStickToBottom(
  viewportRef: RefObject<HTMLDivElement | null>,
  totalSize: number,
  tolerance = 4
): { isAtBottom: boolean; scrollToBottom: (behavior?: ScrollBehavior) => void } {
  const [isAtBottom, setIsAtBottom] = useState(true)
  // True "should we pin" flag. Stays true until the user scrolls away from the
  // bottom; a ref (not state) so the layout effect reads the latest value without
  // waiting for a re-render.
  const stuckRef = useRef(true)
  // Suppresses the stick update during a programmatic smooth scroll: the
  // animation passes through non-bottom positions whose scroll events would
  // otherwise clear `stuckRef` mid-flight and drop a growing tail.
  const smoothScrollingRef = useRef(false)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      if (smoothScrollingRef.current) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance
      stuckRef.current = atBottom
      setIsAtBottom(atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [viewportRef, tolerance])

  // Re-pin to the bottom whenever the content height changes (new message,
  // streaming tail growth, async image remeasure) — but only if still stuck.
  // useLayoutEffect so the assignment lands before paint (no flicker).
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || !stuckRef.current) return
    el.scrollTop = el.scrollHeight
  }, [viewportRef, totalSize])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = viewportRef.current
      if (!el) return
      stuckRef.current = true
      setIsAtBottom(true)
      el.scrollTo({ top: el.scrollHeight, behavior })
      if (behavior === 'smooth') {
        // Ignore scroll events we generated ourselves until the animation ends.
        smoothScrollingRef.current = true
        const reset = () => {
          smoothScrollingRef.current = false
        }
        el.addEventListener('scrollend', reset, { once: true })
        // Fallback: if scrollend never fires, clear shortly after a typical animation.
        window.setTimeout(reset, 500)
      }
    },
    [viewportRef]
  )

  return { isAtBottom, scrollToBottom }
}

type VirtualListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

const VirtualListContext = createContext<VirtualListContextValue | null>(null)

/** Read stick state inside a <VirtualList> (e.g. to render a "scroll to latest" button). */
export function useVirtualList(): VirtualListContextValue {
  const ctx = useContext(VirtualListContext)
  if (!ctx) throw new Error('useVirtualList must be used within <VirtualList>')
  return ctx
}

type VirtualListProps<T> = {
  items: readonly T[]
  /** Stable identity per item — the React key. */
  getKey: (item: T, index: number) => string | number
  renderItem: (item: T, index: number) => React.ReactNode
  /** Class for the wrapper — it owns the scroll height (e.g. "min-h-0 flex-1"). */
  className?: string
  /** Show top/bottom edge fades on the scroller. */
  edgeFade?: boolean
  /** Px within which scrollTop counts as "at the bottom". */
  bottomTolerance?: number
  /** react-virtual overscan (rows rendered outside the visible window). */
  overscan?: number
  /** Initial per-row height estimate in px (corrected at runtime by measureElement). */
  estimateSize?: number
  /** Overlays rendered above the list (e.g. a scroll-to-latest button). */
  children?: React.ReactNode
}

export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  className,
  edgeFade = false,
  bottomTolerance,
  overscan = 8,
  estimateSize = 120,
  children,
}: VirtualListProps<T>): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // getTotalSize() is the re-pin trigger under virtualization: it changes
  // whenever an item is added or a measured row grows (streaming tail, lazy
  // images). Subscribing via onChange keeps it in sync without a separate DOM
  // ResizeObserver competing with react-virtual's own measurements.
  const [totalSize, setTotalSize] = useState(0)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    onChange: (instance) => setTotalSize(instance.getTotalSize()),
  })
  const virtualItems = virtualizer.getVirtualItems()

  const { isAtBottom, scrollToBottom } = useStickToBottom(scrollRef, totalSize, bottomTolerance)

  const ctx = useMemo(() => ({ isAtBottom, scrollToBottom }), [isAtBottom, scrollToBottom])

  return (
    <VirtualListContext.Provider value={ctx}>
      {/* relative wrapper so a consumer's absolute-positioned button (e.g. bottom
          center) anchors against the list, not the page. */}
      <div className={cn('relative', className)}>
        <div
          className={cn(
            // Native scroller — .cmdscroll gives the project's thin low-contrast
            // scrollbar (globals.css). NOT base-ui ScrollArea: that mounts its own
            // ResizeObserver + Root setState and would race react-virtual's measurer.
            'cmdscroll h-full overflow-y-auto'
          )}
          data-virtual-scroller
          ref={scrollRef}
        >
          {/* Total-height placeholder: react-virtual sizes this to getTotalSize()
              so the native scroller has the right scroll range. position:relative
              anchors the absolutely-positioned rows. */}
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const item = items[virtualRow.index]
              const key = String(getKey(item, virtualRow.index))
              return (
                <div
                  data-index={virtualRow.index}
                  key={key}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderItem(item, virtualRow.index)}
                </div>
              )
            })}
          </div>
        </div>
        {edgeFade && (
          <>
            {/* Edge fade + backdrop blur. Content softens and blurs into the
                window-content background at each scroll edge. Native scroller has
                no base-ui data-overflow-* attributes, so visibility is driven by
                isAtBottom (bottom fade) and scrollTop>0 (top fade). */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-9 transition-opacity duration-200"
              style={{
                opacity: scrollRef.current && scrollRef.current.scrollTop > 0 ? 1 : 0,
                background: 'linear-gradient(to bottom, var(--window-content), transparent)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                maskImage: 'linear-gradient(to bottom, #000, transparent)',
                WebkitMaskImage: 'linear-gradient(to bottom, #000, transparent)',
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-9 transition-opacity duration-200"
              style={{
                opacity: isAtBottom ? 0 : 1,
                background: 'linear-gradient(to top, var(--window-content), transparent)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                maskImage: 'linear-gradient(to top, #000, transparent)',
                WebkitMaskImage: 'linear-gradient(to top, #000, transparent)',
              }}
            />
          </>
        )}
        {children}
      </div>
    </VirtualListContext.Provider>
  )
}
