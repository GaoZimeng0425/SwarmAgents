import type { MemoryView } from '@swarm/protocol'
import { orderBy } from 'es-toolkit'
import { Brain } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'

export type MemoryGroup = { category: string; entries: MemoryView[] }

/** Group memory entries by category; groups alphabetical, entries newest-first within each. */
export function groupByCategory(entries: MemoryView[]): MemoryGroup[] {
  const byCategory = new Map<string, MemoryView[]>()
  for (const e of entries) {
    const bucket = byCategory.get(e.category) ?? []
    bucket.push(e)
    byCategory.set(e.category, bucket)
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      entries: orderBy(list, ['timestamp'], ['desc']),
    }))
}

function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

type Props = { entries: MemoryView[]; isError: boolean; onRetry: () => void }

/** Read-only memory list grouped by category. Lives inside RightPanel's Memory tab. */
export function MemoryPanel({ entries, isError, onRetry }: Props): React.JSX.Element {
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
        <Brain className="size-6 opacity-40" />
        <span className="text-[13px]">Couldn't load memory</span>
        <button className="text-[12px] text-primary hover:underline" onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    )
  }
  const groups = groupByCategory(entries)
  return (
    <ScrollArea className="min-h-0 flex-1">
      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center text-muted-foreground/60">
          <Brain className="size-6 opacity-40" />
          <span className="text-[13px]">No memory yet</span>
        </div>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-6">
          {groups.map((g) => (
            <section className="flex flex-col gap-2" key={g.category}>
              <h4 className="font-bold text-[10px] text-muted-foreground/70 uppercase tracking-wider">{g.category}</h4>
              <ul className="flex flex-col gap-3">
                {g.entries.map((e) => (
                  <li className="flex flex-col gap-1" key={e.id}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-[12px] text-foreground/90">{e.key}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
                        {relativeTime(e.timestamp)}
                      </span>
                    </div>
                    <span className="text-[13px] text-muted-foreground/80 leading-relaxed">{e.content}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </ScrollArea>
  )
}
