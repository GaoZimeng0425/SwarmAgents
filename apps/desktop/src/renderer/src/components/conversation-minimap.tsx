import { useEffect, useMemo, useState } from 'react'
import type { RunRecord } from '@shared/lib/apply-event'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@swarm/ui'

import { minimapItems } from '@/lib/minimap-items'
import { cn } from '@/lib/utils'

type Props = { tasks: RunRecord[] }

// A left-edge vertical rail: one tick per user turn. Click a tick to jump to
// that turn; hover to preview its text; the in-view turn's tick is highlighted.
export function ConversationMinimap({ tasks }: Props): React.JSX.Element | null {
  const items = useMemo(() => minimapItems(tasks), [tasks])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Stable dep: only changes when a turn is added/removed, not on every stream tick.
  const idsKey = useMemo(() => items.map((it) => it.runId).join('|'), [items])

  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : []
    if (ids.length < 2) return
    const els = ids
      .map((id) => document.querySelector<HTMLElement>(`[data-task-id="${id}"]`))
      .filter((el): el is HTMLElement => el !== null)
    if (els.length === 0) return

    // Active = the in-view turn closest to the viewport top. rootMargin trims the
    // bottom 60% so only turns near the top count as "current".
    const tops = new Map<string, number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.getAttribute('data-task-id')
          if (!id) continue
          if (e.isIntersecting) tops.set(id, e.boundingClientRect.top)
          else tops.delete(id)
        }
        let best: string | null = null
        let bestTop = Number.POSITIVE_INFINITY
        for (const [id, top] of tops) {
          if (top < bestTop) {
            bestTop = top
            best = id
          }
        }
        // Set unconditionally: when no turn is in the top band, best is null and
        // the highlight clears rather than sticking to a turn that left the view.
        setActiveId(best)
      },
      { rootMargin: '0px 0px -60% 0px' }
    )
    for (const el of els) observer.observe(el)
    return () => observer.disconnect()
  }, [idsKey])

  if (items.length < 2) return null

  const jump = (runId: string): void => {
    document
      .querySelector<HTMLElement>(`[data-run-id="${runId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <TooltipProvider delay={150}>
      <nav
        aria-label="Conversation navigation"
        className="absolute bottom-8 left-3 z-20 flex max-h-[55%] flex-col justify-end gap-1.5 overflow-hidden rounded-full bg-muted/60 p-2 ring-1 ring-border/50 backdrop-blur-sm"
      >
        {items.map((it) => {
          const active = it.runId === activeId
          const label = it.text.trim() ? it.text : '(empty message)'
          const trigger = (
            <button
              aria-label={label.slice(0, 80)}
              className={cn(
                'h-1.5 rounded-full transition-all hover:bg-foreground/70',
                active ? 'w-7 bg-primary' : 'w-4 bg-muted-foreground/40'
              )}
              onClick={() => jump(it.runId)}
              type="button"
            />
          )
          return (
            <Tooltip key={it.runId}>
              <TooltipTrigger render={trigger} />
              <TooltipContent align="end" side="right">
                <p className="line-clamp-4 max-w-xs whitespace-pre-wrap">{label}</p>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
    </TooltipProvider>
  )
}
