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
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'

import { cn } from '@/lib/utils'

/** Alignment of the target item after a `scrollToItem` jump. 'nearest' scrolls
 * the minimum distance that makes the item fully visible. */
export type ScrollAlign = 'start' | 'center' | 'end' | 'nearest'

export type ScrollToItemOptions = {
  /** Where the item lands in the viewport. Default 'start'. */
  align?: ScrollAlign
  /** Scroll behavior. 'smooth' jumps animate and skip settle correction. Default 'auto'. */
  behavior?: ScrollBehavior
  /** Px of earlier content kept visible above the item ('start' only). Default 0. */
  peek?: number
}

type OffsetSource = {
  // Mirrors virtual-core's getOffsetForIndex; the resolved align comes back as
  // 'auto' only when an 'auto'/'nearest' item is already fully visible.
  getOffsetForIndex: (
    index: number,
    align: 'start' | 'center' | 'end' | 'auto'
  ) => readonly [number, 'auto' | 'start' | 'center' | 'end'] | undefined
}

/** Jump target scrollTop for an item index. 'nearest' maps onto the
 * virtualizer's 'auto' (below → end, above → start, visible → no-op); peek
 * shrinks a 'start' landing so earlier content stays visible above the item.
 * Exported for unit tests. */
export function computeItemOffset(
  virtualizer: OffsetSource,
  index: number,
  align: ScrollAlign,
  peek = 0
): number | undefined {
  const resolved = virtualizer.getOffsetForIndex(index, align === 'nearest' ? 'auto' : align)
  if (!resolved) return undefined
  const [offset, finalAlign] = resolved
  return finalAlign === 'start' && peek > 0 ? Math.max(0, offset - peek) : offset
}

// Settle correction: right after a jump, row measurements (estimate → actual)
// keep landing for a few frames and move the real offset of the target. For a
// short window the target offset is re-applied as measurements arrive; wheel /
// touchmove cancel it because physical scroll input outranks the jump.
const SETTLE_WINDOW_MS = 300
const SETTLE_MAX_TRIES = 5
const SETTLE_TOLERANCE_PX = 0.5

type PendingSettle = {
  index: number
  align: ScrollAlign
  peek: number
  tries: number
  deadline: number
}

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
  // True while the primary mouse button is held down. Used by isSelecting() to
  // recognise text selection (drag-select expands the selection and may nudge
  // scrollTop upward) and ignore the resulting scroll events, so stick-to-bottom
  // isn't dropped just because the user selected text in the thread.
  const mouseDownRef = useRef(false)

  useEffect(() => {
    const set = (v: boolean) => () => {
      mouseDownRef.current = v
    }
    document.addEventListener('mousedown', set(true))
    document.addEventListener('mouseup', set(false))
    // A click always ends a drag-select (mouseup may be missed if it happens
    // off-window); clear so a leftover flag can't suppress later real scrolls.
    document.addEventListener('click', set(false))
    return () => {
      document.removeEventListener('mousedown', set(true))
      document.removeEventListener('mouseup', set(false))
      document.removeEventListener('click', set(false))
    }
  }, [])

  // True when the user is currently drag-selecting text inside the scroller.
  // Selection extension can move scrollTop; those scrolls are side-effects of
  // selection, not a user intent to leave the bottom — so onScroll skips its
  // judgement while this returns true, keeping the prior stuck state intact.
  const isSelecting = useCallback(() => {
    if (!mouseDownRef.current) return false
    const el = viewportRef.current
    if (!el) return false
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    return range.commonAncestorContainer.contains(el) || el.contains(range.commonAncestorContainer)
  }, [viewportRef])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onScroll = () => {
      if (smoothScrollingRef.current) return
      if (isSelecting()) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance
      stuckRef.current = atBottom
      setIsAtBottom(atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [viewportRef, tolerance, isSelecting])

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
  /** Jump to the item with this key (need not be mounted); returns false when
   * the key is unknown. Lands with `align`, optionally keeping `peek` px of
   * earlier content visible above it. */
  scrollToItem: (key: string, opts?: ScrollToItemOptions) => boolean
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

  // Item key → index, so scrollToItem can resolve jumps through the height
  // table (measured or estimated) without the target row being mounted.
  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>()
    items.forEach((it, i) => {
      map.set(String(getKey(it, i)), i)
    })
    return map
  }, [items, getKey])

  // In-flight jump correction (PendingSettle). Refs so the virtualizer's
  // onChange can schedule it without re-subscribing.
  const pendingSettleRef = useRef<PendingSettle | null>(null)
  const settleFrameRef = useRef<number | null>(null)

  // getTotalSize() is the re-pin trigger under virtualization: it changes
  // whenever an item is added or a measured row grows (streaming tail, lazy
  // images). Subscribing via onChange keeps it in sync without a separate DOM
  // ResizeObserver competing with react-virtual's measurements.
  const [totalSize, setTotalSize] = useState(0)

  // Re-check a pending jump from a rAF (never re-entrantly inside onChange):
  // if landed position still differs from the recomputed target, re-apply.
  const scheduleSettle = useCallback((instance: Virtualizer<HTMLDivElement, Element>) => {
    if (pendingSettleRef.current === null || settleFrameRef.current !== null) return
    settleFrameRef.current = requestAnimationFrame(() => {
      settleFrameRef.current = null
      const pending = pendingSettleRef.current
      if (!pending) return
      if (Date.now() > pending.deadline || pending.tries >= SETTLE_MAX_TRIES) {
        pendingSettleRef.current = null
        return
      }
      const target = computeItemOffset(instance, pending.index, pending.align, pending.peek)
      const el = scrollRef.current
      if (target === undefined || !el) return
      if (Math.abs(el.scrollTop - target) <= SETTLE_TOLERANCE_PX) {
        pendingSettleRef.current = null
        return
      }
      pending.tries += 1
      instance.scrollToOffset(target, { behavior: 'auto' })
    })
  }, [])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    onChange: (instance) => {
      setTotalSize(instance.getTotalSize())
      // Measurement commits (estimate → actual) can move a recent jump's
      // landing spot; scheduleSettle re-applies the target within its window.
      scheduleSettle(instance)
    },
  })
  const virtualItems = virtualizer.getVirtualItems()

  // Physical scroll input outranks an in-flight jump correction.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const cancel = () => {
      pendingSettleRef.current = null
    }
    el.addEventListener('wheel', cancel, { passive: true })
    el.addEventListener('touchmove', cancel, { passive: true })
    return () => {
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('touchmove', cancel)
      if (settleFrameRef.current !== null) cancelAnimationFrame(settleFrameRef.current)
    }
  }, [])

  const scrollToItem = useCallback(
    (key: string, opts?: ScrollToItemOptions): boolean => {
      const index = keyToIndex.get(key)
      if (index === undefined) return false
      const align = opts?.align ?? 'start'
      const peek = opts?.peek ?? 0
      const target = computeItemOffset(virtualizer, index, align, peek)
      if (target === undefined) return false
      const behavior = opts?.behavior ?? 'auto'
      virtualizer.scrollToOffset(target, { behavior })
      if (behavior !== 'smooth') {
        // Smooth jumps animate; correcting mid-flight would fight the animation.
        pendingSettleRef.current = {
          align,
          deadline: Date.now() + SETTLE_WINDOW_MS,
          index,
          peek,
          tries: 0,
        }
        scheduleSettle(virtualizer)
      }
      return true
    },
    [keyToIndex, virtualizer, scheduleSettle]
  )

  const { isAtBottom, scrollToBottom: stickScrollToBottom } = useStickToBottom(scrollRef, totalSize, bottomTolerance)

  // A pinned jump to the bottom outranks any in-flight item correction.
  const scrollToBottom = useCallback(
    (behavior?: ScrollBehavior) => {
      pendingSettleRef.current = null
      stickScrollToBottom(behavior)
    },
    [stickScrollToBottom]
  )

  const ctx = useMemo(() => ({ isAtBottom, scrollToBottom, scrollToItem }), [isAtBottom, scrollToBottom, scrollToItem])

  return (
    <VirtualListContext.Provider value={ctx}>
      {/* relative wrapper so a consumer's absolute-positioned button (e.g. bottom
          center) anchors against the list, not the page. */}
      <div className={cn('relative', className)}>
        {/* biome-ignore lint/a11y/useSemanticElements: the scroller is HTMLDivElement end to end; a <section> would ripple through the virtualizer's element typing */}
        <div
          aria-label="Messages"
          className={cn(
            // Native scroller — .cmdscroll gives the project's thin low-contrast
            // scrollbar (globals.css). NOT base-ui ScrollArea: that mounts its own
            // ResizeObserver + Root setState and would race react-virtual's measurer.
            // region + tabIndex give keyboard users a focusable scroll surface.
            'cmdscroll h-full overflow-y-auto'
          )}
          data-virtual-scroller
          ref={scrollRef}
          role="region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard focus to be keyboard-scrollable (WCAG 2.1.1)
          tabIndex={0}
        >
          {/* Total-height placeholder: react-virtual sizes this to getTotalSize()
              so the native scroller has the right scroll range. position:relative
              anchors the absolutely-positioned rows. role="log" carries chat
              transcript semantics (announces appended messages); caveat: the
              virtualizer also mounts/unmounts off-screen rows — revisit if that
              proves noisy in screen-reader testing. */}
          <div aria-relevant="additions" role="log" style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const item = items[virtualRow.index]
              const key = String(getKey(item, virtualRow.index))
              return (
                <div
                  data-index={virtualRow.index}
                  data-message-id={key}
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
