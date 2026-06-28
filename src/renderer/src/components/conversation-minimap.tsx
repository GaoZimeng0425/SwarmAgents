import { useEffect, useMemo, useState } from 'react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TaskRecord } from '@/lib/apply-event'
import { minimapItems } from '@/lib/minimap-items'
import { cn } from '@/lib/utils'

type Props = { tasks: TaskRecord[] }

// A left-edge vertical rail: one tick per user turn. Click a tick to jump to
// that turn; hover to preview its text; the in-view turn's tick is highlighted.
export function ConversationMinimap({ tasks }: Props): React.JSX.Element | null {
  const items = useMemo(() => minimapItems(tasks), [tasks])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Stable dep: only changes when a turn is added/removed, not on every stream tick.
  const idsKey = items.map((it) => it.taskId).join('|')

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
        if (best) setActiveId(best)
      },
      { rootMargin: '0px 0px -60% 0px' }
    )
    for (const el of els) observer.observe(el)
    return () => observer.disconnect()
  }, [idsKey])

  if (items.length < 2) return null

  const jump = (taskId: string): void => {
    document
      .querySelector<HTMLElement>(`[data-task-id="${taskId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  return (
    <TooltipProvider delay={150}>
      <nav
        aria-label="Conversation navigation"
        className="absolute bottom-6 left-2 z-20 flex max-h-[60%] flex-col justify-end gap-1.5 overflow-hidden"
      >
        {items.map((it) => {
          const active = it.taskId === activeId
          const label = it.text.trim() ? it.text : '(empty message)'
          const trigger = (
            <button
              aria-label={label.slice(0, 80)}
              className={cn(
                'h-0.5 rounded-full bg-muted-foreground/30 transition-all hover:bg-primary',
                active ? 'w-6 bg-primary' : 'w-4'
              )}
              onClick={() => jump(it.taskId)}
              type="button"
            />
          )
          return (
            <Tooltip key={it.taskId}>
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
