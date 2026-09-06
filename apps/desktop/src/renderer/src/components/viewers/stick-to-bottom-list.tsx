// Message list that stays pinned to the bottom while new content streams in —
// the chat/transcript UX. Every row is rendered directly inside the styled
// ScrollArea (no virtualization): the project trades the bounded DOM of
// `@tanstack/react-virtual` for the simplicity and correctness of a plain
// scrolling container — react-virtual could not reliably measure the base-ui
// ScrollArea viewport under React 19 (rows mounted as 0 while getTotalSize was
// non-zero). A ResizeObserver on the content re-pins to the bottom whenever it
// grows while the user is still stuck there.
//
// Why hand-rolled (not the `use-stick-to-bottom` lib): the library renders its
// own native-scrollbar scroller, which violates the project rule that every
// scroll container uses the styled ScrollArea. This composes ScrollArea instead.
import {
  createContext,
  type RefCallback,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

// `useStickToBottom` is exported for direct unit testing of its state machine.
// It reads/writes the scroll element's geometry directly; in the test DOM those are 0,
// so tests mock scrollHeight/clientHeight/scrollTop on the element instance.
export function useStickToBottom(
  viewportRef: React.RefObject<HTMLDivElement | null>,
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

type StickToBottomListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /** Scroll a specific row into view by its key. */
  scrollToKey: (key: string, align?: 'start' | 'center' | 'end') => void
}

const StickToBottomListContext = createContext<StickToBottomListContextValue | null>(null)

/** Read stick state inside a <StickToBottomList> (e.g. to render a "scroll to latest" button). */
export function useStickToBottomList(): StickToBottomListContextValue {
  const ctx = useContext(StickToBottomListContext)
  if (!ctx) throw new Error('useStickToBottomList must be used within <StickToBottomList>')
  return ctx
}

type StickToBottomListProps<T> = {
  items: readonly T[]
  /** Stable identity per item — the React key and the scrollToKey target. */
  getKey: (item: T, index: number) => string | number
  renderItem: (item: T, index: number) => React.ReactNode
  /** Class for the wrapper — it owns the scroll height (e.g. "min-h-0 flex-1"). */
  className?: string
  /** Show top/bottom edge fades on the ScrollArea. */
  edgeFade?: boolean
  /** Px within which scrollTop counts as "at the bottom". */
  bottomTolerance?: number
  /** Overlays rendered above the list (e.g. a scroll-to-latest button). */
  children?: React.ReactNode
}

export function StickToBottomList<T>({
  items,
  getKey,
  renderItem,
  className,
  edgeFade = false,
  bottomTolerance,
  children,
}: StickToBottomListProps<T>): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Content height is the re-pin trigger: it changes whenever an item is added
  // or a row grows in place (streaming tail, lazy images). items.length alone
  // would miss in-place growth, so observe the content element directly.
  const [contentHeight, setContentHeight] = useState(0)
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContentHeight(el.scrollHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { isAtBottom, scrollToBottom } = useStickToBottom(viewportRef, contentHeight, bottomTolerance)

  // key → element so scrollToKey can deep-link to a row without a CSS selector
  // (keys are arbitrary strings that would need escaping in an attribute
  // selector). The shared callback reads data-scroll-key; a stale entry left by
  // an unmounted row is harmless (scrollIntoView on a detached node is a no-op,
  // and a remounted key overwrites it).
  const itemEls = useRef(new Map<string, HTMLElement>()).current
  const registerItem: RefCallback<HTMLDivElement> = useCallback(
    (el) => {
      if (el) itemEls.set(el.dataset.scrollKey ?? '', el)
    },
    [itemEls]
  )
  const scrollToKey = useCallback(
    (key: string, align: 'start' | 'center' | 'end' = 'center') => {
      // All rows are mounted (no virtualization), so the element is always
      // present for a known key. Optional-chain the method: the test DOM may
      // lack scrollIntoView, and the test only asserts "does not throw".
      itemEls.get(String(key))?.scrollIntoView?.({ block: align, behavior: 'smooth' })
    },
    [itemEls]
  )

  const ctx = useMemo(() => ({ isAtBottom, scrollToBottom, scrollToKey }), [isAtBottom, scrollToBottom, scrollToKey])

  return (
    <StickToBottomListContext.Provider value={ctx}>
      {/* relative wrapper so a consumer's absolute-positioned button (e.g. bottom
          center) anchors against the list, not the page. */}
      <div className={cn('relative', className)}>
        <ScrollArea className="size-full" edgeFade={edgeFade} viewportRef={viewportRef}>
          <div ref={contentRef}>
            {items.map((item, index) => {
              const key = String(getKey(item, index))
              return (
                <div data-scroll-key={key} key={key} ref={registerItem}>
                  {renderItem(item, index)}
                </div>
              )
            })}
          </div>
        </ScrollArea>
        {children}
      </div>
    </StickToBottomListContext.Provider>
  )
}
