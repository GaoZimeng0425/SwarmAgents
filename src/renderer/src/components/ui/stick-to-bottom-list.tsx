// Virtualized message list that stays pinned to the bottom while new content
// streams in — the chat/transcript UX — without giving up the bounded DOM of
// `@tanstack/react-virtual`. Reuses `useVirtualList` + `<VirtualRows>` from
// virtual-list.tsx and layers a hand-rolled stick-to-bottom behavior on top.
//
// Why hand-rolled (not the `use-stick-to-bottom` lib): the library renders its
// own native-scrollbar scroller, which violates the project rule that every
// scroll container uses the styled ScrollArea. This composes ScrollArea instead.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useVirtualList, VirtualRows } from '@/components/ui/virtual-list'
import { cn } from '@/lib/utils'

// `useStickToBottom` is exported for direct unit testing of its state machine.
// It reads/writes the scroll element's geometry directly; in jsdom those are 0,
// so tests mock scrollHeight/clientHeight/scrollTop on the element instance.
export function useStickToBottom(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  totalSize: number,
  tolerance = 4,
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

  // Re-pin to the bottom whenever the virtualized height changes (new message,
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
    [viewportRef],
  )

  return { isAtBottom, scrollToBottom }
}

type StickToBottomListContextValue = {
  isAtBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
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
  /** Stable identity per item — keeps the measurement cache correct. */
  getKey: (item: T, index: number) => string | number
  renderItem: (item: T, index: number) => React.ReactNode
  /** Rough average row height (px) for the first paint. */
  estimateSize?: number
  /** Rows rendered beyond each viewport edge. */
  overscan?: number
  /** Vertical gap between rows (px). */
  gap?: number
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
  estimateSize,
  overscan,
  gap,
  className,
  edgeFade = false,
  bottomTolerance,
  children,
}: StickToBottomListProps<T>): React.JSX.Element {
  const { viewportRef, virtualizer } = useVirtualList({ items, getKey, estimateSize, overscan, gap })
  const totalSize = virtualizer.getTotalSize()
  const { isAtBottom, scrollToBottom } = useStickToBottom(viewportRef, totalSize, bottomTolerance)

  const ctx = useMemo(
    () => ({ isAtBottom, scrollToBottom }),
    [isAtBottom, scrollToBottom],
  )

  return (
    <StickToBottomListContext.Provider value={ctx}>
      {/* relative wrapper so a consumer's absolute-positioned button (e.g. bottom
          center) anchors against the list, not the page. */}
      <div className={cn('relative', className)}>
        <ScrollArea className="size-full" edgeFade={edgeFade} viewportRef={viewportRef}>
          <VirtualRows items={items} renderItem={renderItem} virtualizer={virtualizer} />
        </ScrollArea>
        {children}
      </div>
    </StickToBottomListContext.Provider>
  )
}
