// Slim dashboard top bar: section title, a "运行中" pill (running/pending
// count), and a search button that opens the global session search (⌘K).

import { useSearchDialog } from '@/stores/search-dialog'

type Props = { runningCount: number }

export function DashboardTopbar({ runningCount }: Props): React.JSX.Element {
  const openSearch = useSearchDialog((s) => s.openSearch)

  return (
    // Doubles as the window drag region (no native title bar); interactive
    // controls opt back out below.
    <div
      className="flex h-13 shrink-0 items-center gap-2.5 px-7"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <h1 className="font-semibold text-[13px] text-muted-foreground">任务台</h1>
      <div className="ml-auto flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 font-medium text-[12px] text-primary">
            <span className="size-1.5 rounded-full bg-primary" />
            {runningCount} 个运行中
          </span>
        )}
        <button
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent/30"
          onClick={openSearch}
          type="button"
        >
          搜索
          <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">⌘K</kbd>
        </button>
      </div>
    </div>
  )
}
