// Right-side Sheet that shows the full weather detail. Presentation-only: reads
// the same useWeather() store as the strip (opening it never triggers a fetch);
// the ↻ button reuses the store's refresh(). Scroll uses ScrollArea per project rule.

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
  const busy = status === 'locating' || status === 'fetching'
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="flex w-[440px] flex-col p-0 sm:max-w-[440px]" side="right">
        <SheetHeader className="border-border border-b px-5 py-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <SheetTitle className="text-base">📍 {forecast?.location ?? '定位中…'}</SheetTitle>
              {forecast && (
                <p className="mt-0.5 text-muted-foreground text-xs">和风天气 · {relativeTime(forecast.fetchedAt)}</p>
              )}
            </div>
            <button
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onClick={() => void refresh()}
              type="button"
            >
              <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} />
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
