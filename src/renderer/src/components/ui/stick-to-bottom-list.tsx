// Virtualized message list that stays pinned to the bottom while new content
// streams in — the chat/transcript UX — without giving up the bounded DOM of
// `@tanstack/react-virtual`. Reuses `useVirtualList` + `<VirtualRows>` from
// virtual-list.tsx and layers a hand-rolled stick-to-bottom behavior on top.
//
// Why hand-rolled (not the `use-stick-to-bottom` lib): the library renders its
// own native-scrollbar scroller, which violates the project rule that every
// scroll container uses the styled ScrollArea. This composes ScrollArea instead.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
