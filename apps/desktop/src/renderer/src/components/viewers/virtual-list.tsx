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
  useSyncExternalStore,
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

// Turn anchoring: when a freshly sent user message appears, the viewport jumps
// to it (start-aligned with the previous reply peeking above) and stays pinned
// there while the response streams in below it.
const ANCHOR_PEEK = 64

// Keys that read as "the user took over" when pressed inside the scroller.
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '])

/** Anchor keys that appeared since the previous items render. The very first
 * run (session open / whole-list hydrate) yields none, so opening a session
 * lands at the bottom instead of jumping to an anchor. Exported for tests. */
export function pickNewAnchors(prev: ReadonlySet<string>, next: readonly string[], hasRendered: boolean): string[] {
  if (!hasRendered) return []
  return next.filter((key) => !prev.has(key))
}

// Visibility tracking (Phase B): which items intersect the viewport, and which
// scroll-anchor item owns the top of it. Backed by an IntersectionObserver over
// the mounted rows only — visible rows are always mounted under virtualization.
export type VirtualListVisibility = {
  visibleKeys: readonly string[]
  currentAnchorKey: string | null
}

const EMPTY_VISIBILITY: VirtualListVisibility = { visibleKeys: [], currentAnchorKey: null }

type VisibilityStore = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => VirtualListVisibility
  hasListeners: () => boolean
  setSnapshot: (next: VirtualListVisibility) => void
}

function sameVisibility(a: VirtualListVisibility, b: VirtualListVisibility): boolean {
  if (a.currentAnchorKey !== b.currentAnchorKey || a.visibleKeys.length !== b.visibleKeys.length) {
    return false
  }
  return a.visibleKeys.every((key, i) => key === b.visibleKeys[i])
}

function createVisibilityStore(): VisibilityStore {
  let snapshot = EMPTY_VISIBILITY
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    hasListeners: () => listeners.size > 0,
    setSnapshot(next) {
      if (sameVisibility(snapshot, next)) return
      snapshot = next
      listeners.forEach((listener) => {
        listener()
      })
    },
  }
}

// `useStickToBottom` is exported for direct unit testing of its state machine.
// It reads/writes the scroll element's geometry directly; in jsdom those are 0,
// so tests mock scrollHeight/clientHeight/scrollTop on the element instance.
export function useStickToBottom(
  viewportRef: RefObject<HTMLDivElement | null>,
  totalSize: number,
  tolerance = 4,
  options?: { pinSuspenderRef?: RefObject<boolean> }
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
  // Turn-anchor mode suspends this pin: it keeps the anchored turn's start
  // aligned instead, so a bottom pin here would fight it every frame.
  useLayoutEffect(() => {
    if (options?.pinSuspenderRef?.current) return
    const el = viewportRef.current
    if (!el || !stuckRef.current) return
    el.scrollTop = el.scrollHeight
  }, [viewportRef, totalSize, options])

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
  visibility: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => VirtualListVisibility
  }
}

const VirtualListContext = createContext<VirtualListContextValue | null>(null)

/** Read stick state inside a <VirtualList> (e.g. to render a "scroll to latest" button). */
export function useVirtualList(): VirtualListContextValue {
  const ctx = useContext(VirtualListContext)
  if (!ctx) throw new Error('useVirtualList must be used within <VirtualList>')
  return ctx
}

/** Subscribe to which items are on screen and which anchor item owns the top of
 * the viewport. Updates are rAF-coalesced; the observer only runs while at
 * least one subscriber is mounted. */
export function useVirtualListVisibility(): VirtualListVisibility {
  const { visibility } = useVirtualList()
  return useSyncExternalStore(visibility.subscribe, visibility.getSnapshot, visibility.getSnapshot)
}

type VirtualListProps<T> = {
  items: readonly T[]
  /** Stable identity per item — the React key. */
  getKey: (item: T, index: number) => string | number
  renderItem: (item: T, index: number) => React.ReactNode
  /** Marks turn-start items. When a single new anchor appears outside session
   * open, the viewport jumps to it (start-aligned, peek above) and stays
   * pinned while it streams — wheel/touch/scrolling away releases the pin. */
  getScrollAnchor?: (item: T) => boolean
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
  getScrollAnchor,
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

  // Turn anchoring. `anchorRef` is the pinned turn (null = plain
  // stick-to-bottom). `programmaticScrollRef` is a consume-once flag telling
  // the exit listener that the next scroll event is our own pin/jump.
  // `pinSuspenderRef` (mirrored each render) suspends the stick hook's bottom
  // pin while an anchor owns the viewport.
  const anchorRef = useRef<{ key: string; peek: number } | null>(null)
  const programmaticScrollRef = useRef(false)
  const pinSuspenderRef = useRef(false)
  const prevAnchorKeysRef = useRef<Set<string>>(new Set())
  const hasRenderedRef = useRef(false)
  pinSuspenderRef.current = anchorRef.current !== null
  const stickOptions = useMemo(() => ({ pinSuspenderRef }), [])

  // Anchor keys in render order — drives turn-anchor detection and the
  // visibility snapshot's currentAnchorKey. Ref mirrors let the rAF-coalesced
  // visibility pass and effects read the latest lists without re-subscribing.
  const anchorKeys = useMemo(() => {
    if (!getScrollAnchor) return []
    const keys: string[] = []
    items.forEach((it, i) => {
      if (getScrollAnchor(it)) keys.push(String(getKey(it, i)))
    })
    return keys
  }, [items, getKey, getScrollAnchor])
  const anchorKeysRef = useRef(anchorKeys)
  anchorKeysRef.current = anchorKeys
  const itemKeys = useMemo(() => items.map((it, i) => String(getKey(it, i))), [items, getKey])
  const itemKeysRef = useRef(itemKeys)
  itemKeysRef.current = itemKeys

  // Visibility runtime. The IntersectionObserver exists only while at least
  // one useVirtualListVisibility() subscriber is mounted; snapshots commit on
  // a rAF so bursts of IO/scroll events collapse into one re-render.
  const visibilityRuntimeRef = useRef<{
    store: VisibilityStore
    elements: Map<string, Element>
    visible: Set<string>
    observer: IntersectionObserver | null
    frame: number | null
  } | null>(null)
  const getVisibilityRuntime = useCallback(() => {
    let runtime = visibilityRuntimeRef.current
    if (!runtime) {
      runtime = {
        store: createVisibilityStore(),
        elements: new Map(),
        visible: new Set(),
        observer: null,
        frame: null,
      }
      visibilityRuntimeRef.current = runtime
    }
    return runtime
  }, [])
  const syncVisibility = useCallback(() => {
    const runtime = visibilityRuntimeRef.current
    if (!runtime?.store.hasListeners() || runtime.frame !== null) return
    runtime.frame = requestAnimationFrame(() => {
      runtime.frame = null
      const el = scrollRef.current
      if (!el) return
      const anchorLine = el.getBoundingClientRect().top + ANCHOR_PEEK
      let currentAnchorKey: string | null = null
      for (const key of anchorKeysRef.current) {
        const element = runtime.elements.get(key)
        if (element && element.getBoundingClientRect().top <= anchorLine) {
          currentAnchorKey = key
        }
      }
      const visibleKeys = itemKeysRef.current.filter((key) => runtime.visible.has(key))
      runtime.store.setSnapshot({ currentAnchorKey, visibleKeys })
    })
  }, [])
  const startVisibilityObserver = useCallback(() => {
    const runtime = getVisibilityRuntime()
    if (typeof IntersectionObserver === 'undefined' || runtime.observer) return
    const el = scrollRef.current
    if (!el) return
    runtime.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.messageId
          if (!key) continue
          if (entry.isIntersecting) runtime.visible.add(key)
          else runtime.visible.delete(key)
        }
        syncVisibility()
      },
      { root: el, threshold: [0, 0.01, 0.5, 1] }
    )
    for (const element of runtime.elements.values()) {
      runtime.observer.observe(element)
    }
    syncVisibility()
  }, [getVisibilityRuntime, syncVisibility])
  const visibilitySubscribe = useCallback(
    (listener: () => void) => {
      const runtime = getVisibilityRuntime()
      const unsubscribe = runtime.store.subscribe(listener)
      if (runtime.store.hasListeners()) startVisibilityObserver()
      return () => {
        unsubscribe()
        if (!runtime.store.hasListeners()) {
          runtime.observer?.disconnect()
          runtime.observer = null
          if (runtime.frame !== null) cancelAnimationFrame(runtime.frame)
          runtime.frame = null
          runtime.visible.clear()
        }
      }
    },
    [getVisibilityRuntime, startVisibilityObserver]
  )
  const visibilityGetSnapshot = useCallback(
    () => visibilityRuntimeRef.current?.store.getSnapshot() ?? EMPTY_VISIBILITY,
    []
  )

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
      programmaticScrollRef.current = true
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

  // Stable per-key row refs: keep the virtualizer's measureElement wiring AND
  // register the element for visibility tracking, without detaching the ref
  // (and re-measuring) on every render.
  const rowRefsRef = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const getRowRef = useCallback(
    (key: string) => {
      let ref = rowRefsRef.current.get(key)
      if (!ref) {
        ref = (node: HTMLDivElement | null) => {
          virtualizer.measureElement(node)
          const runtime = visibilityRuntimeRef.current
          if (!runtime) return
          if (node) {
            runtime.elements.set(key, node)
            runtime.observer?.observe(node)
            syncVisibility()
          } else {
            runtime.elements.delete(key)
            runtime.visible.delete(key)
          }
        }
        rowRefsRef.current.set(key, ref)
      }
      return ref
    },
    [virtualizer, syncVisibility]
  )

  // Physical scroll input outranks an in-flight jump correction and releases
  // the turn-anchor pin.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const cancel = () => {
      pendingSettleRef.current = null
      anchorRef.current = null
    }
    const onScroll = () => {
      // Consume-once: our own jumps and anchor pins arm this flag; an unarmed
      // scroll event is the user taking over, which releases the anchor.
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false
        return
      }
      anchorRef.current = null
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (NAVIGATION_KEYS.has(event.key)) cancel()
    }
    el.addEventListener('wheel', cancel, { passive: true })
    el.addEventListener('touchmove', cancel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('touchmove', cancel)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('keydown', onKeyDown)
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
      programmaticScrollRef.current = true
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

  // Turn-anchor detection: a single fresh anchor (a just-sent user message)
  // claims the viewport; batch arrivals (session open / whole-list hydrate)
  // fall back to the default stick-to-bottom landing.
  useEffect(() => {
    const fresh = pickNewAnchors(prevAnchorKeysRef.current, anchorKeys, hasRenderedRef.current)
    prevAnchorKeysRef.current = new Set(anchorKeys)
    hasRenderedRef.current = true
    if (fresh.length !== 1) return
    const key = fresh[0]
    if (scrollToItem(key, { align: 'start', peek: ANCHOR_PEEK })) {
      anchorRef.current = { key, peek: ANCHOR_PEEK }
    }
  }, [anchorKeys, scrollToItem])

  // While a turn is anchored, keep it start-aligned (peek above) across
  // measurement changes — before paint, and flagged programmatic so the exit
  // listener doesn't mistake our own pin for the user taking over.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const index = keyToIndex.get(anchor.key)
    const el = scrollRef.current
    if (index === undefined || !el) return
    const target = computeItemOffset(virtualizer, index, 'start', anchor.peek)
    if (target === undefined) return
    programmaticScrollRef.current = true
    el.scrollTop = target
  }, [totalSize, keyToIndex, virtualizer])

  const { isAtBottom, scrollToBottom: stickScrollToBottom } = useStickToBottom(
    scrollRef,
    totalSize,
    bottomTolerance,
    stickOptions
  )

  // A pinned jump to the bottom outranks any in-flight item correction and
  // releases the turn anchor.
  const scrollToBottom = useCallback(
    (behavior?: ScrollBehavior) => {
      pendingSettleRef.current = null
      anchorRef.current = null
      stickScrollToBottom(behavior)
    },
    [stickScrollToBottom]
  )

  const ctx = useMemo(
    () => ({
      isAtBottom,
      scrollToBottom,
      scrollToItem,
      visibility: { subscribe: visibilitySubscribe, getSnapshot: visibilityGetSnapshot },
    }),
    [isAtBottom, scrollToBottom, scrollToItem, visibilitySubscribe, visibilityGetSnapshot]
  )

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
                  ref={getRowRef(key)}
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
