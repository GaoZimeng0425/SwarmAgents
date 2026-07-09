// Right-side Sheet that shows the full weather detail. Presentation-only: reads
// the same useWeather() forecast as the strip (a fresh cache hit, so opening it
// never triggers a fetch); the ↻ button reuses refresh(). Scroll uses ScrollArea
// per project rule.

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@swarm/ui'
import { RefreshCw } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useWeather } from '@/hooks/use-weather'
import { WeatherDetail } from './weather-detail'
import { relativeTime } from './weather-shared'

export function WeatherDrawer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}): React.JSX.Element {
  const { forecast, refresh, status } = useWeather()
  const busy = status === 'fetching'
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-[440px] flex-col p-0 sm:max-w-[440px]" side="right">
        <SheetHeader className="border-border border-b px-5 py-4">
          <SheetTitle className="text-base">📍 {forecast?.location ?? '定位中…'}</SheetTitle>
          {/* Refresh sits inline to the right of the "fetched N ago" line, clear
              of the Sheet's built-in close X in the top-right corner. */}
          <div className="flex items-center gap-1.5">
            {forecast && (
              <p className="text-muted-foreground text-xs">
                和风天气 · <span className="text-muted-foreground/60">{relativeTime(forecast.fetchedAt)}</span>
              </p>
            )}
            <button
              aria-label="刷新"
              className="ml-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onClick={() => void refresh()}
              type="button"
            >
              <RefreshCw className={busy ? 'size-2.5 animate-spin' : 'size-2.5'} />
            </button>
          </div>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-5 pt-4 pb-6">
          <WeatherDetail />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
