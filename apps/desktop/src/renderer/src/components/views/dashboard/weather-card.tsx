// Dashboard weather widget — compact status strip (matches the 首页 Dashboard
// design). A pure reader of useWeather's React Query forecast (caching + refresh
// live there). Overview only; clicking opens WeatherDrawer for the full detail.
// Unconfigured → a one-row link into Settings → weather. The panel uses a raised
// surface (bg-secondary) so it doesn't sink into the page-colored background.
import { useState } from 'react'
import { Button } from '@swarm/ui'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'

import { useSettingsNav } from '@/hooks/use-settings-nav'
import { useWeather } from '@/hooks/use-weather'
import { WeatherDrawer } from './weather-drawer'
import { aqiHex, weatherEmoji } from './weather-shared'

export function WeatherCard(): React.JSX.Element {
  // Fetching, caching (staleTime), and window-focus refresh are all owned by the
  // React Query query inside useWeather — the strip is a pure reader now.
  const { config, forecast, status, error, refresh } = useWeather()
  const { openSettings } = useSettingsNav()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const configured = !!config.projectId && !!config.credentialId && config.hasPrivateKey
  if (!configured) {
    return (
      <button
        className="flex w-full items-center justify-between rounded-2xl border border-border bg-secondary px-4 py-3 text-left transition-colors hover:bg-secondary/80"
        onClick={() => openSettings('weather')}
        type="button"
      >
        <span className="text-sm">
          <span className="mr-2">🌤️</span>天气 · 配置和风天气凭据
        </span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </button>
    )
  }

  // The drawer is mounted unconditionally (whenever configured) so that a
  // refresh triggered from inside the drawer — including its own ↻ button —
  // doesn't fall through to the strip's skeleton/error branches below and
  // unmount (and thus slam shut) an already-open drawer.
  return (
    <>
      <StripContent
        error={error}
        forecast={forecast}
        onOpenDrawer={() => setDrawerOpen(true)}
        refresh={refresh}
        status={status}
      />
      <WeatherDrawer onOpenChange={setDrawerOpen} open={drawerOpen} />
    </>
  )
}

function StripContent({
  status,
  error,
  forecast,
  refresh,
  onOpenDrawer,
}: {
  status: ReturnType<typeof useWeather>['status']
  error: string | null
  forecast: ReturnType<typeof useWeather>['forecast']
  refresh: () => Promise<void>
  onOpenDrawer: () => void
}): React.JSX.Element {
  // Cold state — nothing cached yet: show the error card (with retry) or the
  // loading skeleton. Once a forecast exists we never fall back here, so a
  // background refresh (or a failed one) keeps the last-known reading on screen
  // instead of flashing a skeleton — stale-while-revalidate.
  if (!forecast) {
    if (status === 'error') {
      return (
        <div className="flex items-center justify-between rounded-2xl border border-border bg-secondary px-4 py-3">
          <span className="text-destructive text-sm">{error ?? '天气获取失败'}</span>
          <Button onClick={() => void refresh()} size="sm" variant="ghost">
            重试
          </Button>
        </div>
      )
    }
    return <StripSkeleton />
  }

  const now = forecast.now
  const h0 = forecast.hours[0]
  const temp = Math.round(now?.temp ?? h0?.tempC ?? 0)
  const text = now?.text ?? h0?.text ?? ''
  const icon = now?.icon ?? h0?.icon ?? ''
  const feelsLike = now ? Math.round(now.feelsLike) : null
  const pop = h0?.pop ?? 0
  const temps = forecast.hours.map((h) => h.tempC)
  const warning = forecast.warnings[0]
  const extraWarnings = forecast.warnings.length - 1

  return (
    <button
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-secondary px-4 py-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-secondary/80"
      onClick={onOpenDrawer}
      type="button"
    >
      <span className="flex-none text-2xl leading-none">{weatherEmoji(icon)}</span>
      <span className="flex-none items-baseline tabular-nums">
        <span className="font-normal text-2xl">{temp}</span>
        <span className="text-muted-foreground text-sm">°</span>
      </span>
      <div className="min-w-0 flex-none">
        <div className="truncate font-semibold text-[12.5px] text-foreground">{forecast.location}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {text}
          {feelsLike !== null && ` · 体感 ${feelsLike}°`} · 降水 {pop}%
        </div>
      </div>

      <span className="flex-1" />

      {warning && (
        <span className="flex flex-none items-center gap-1 rounded-full bg-amber-500/15 px-2 py-1 font-semibold text-[10.5px] text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3" />
          {warning.typeName}预警
          {extraWarnings > 0 && ` +${extraWarnings}`}
        </span>
      )}
      {forecast.air && (
        <span
          className="flex-none rounded-full px-2 py-1 font-semibold text-[10.5px]"
          style={{ color: aqiHex(forecast.air.category), backgroundColor: `${aqiHex(forecast.air.category)}22` }}
        >
          AQI {forecast.air.category} {forecast.air.aqi}
        </span>
      )}
      {temps.length > 1 && <Sparkline temps={temps} />}
      <ChevronRight className="size-4 flex-none text-muted-foreground" />
    </button>
  )
}

// Decorative 24h temperature trend: a gradient area sparkline (design accent
// blue), no axes/tooltip. Fixed hue — a semantic weather-trend color that reads
// on both the light and dark raised panel.
function Sparkline({ temps }: { temps: number[] }): React.JSX.Element {
  const data = temps.map((t) => ({ t }))
  return (
    <div className="h-[26px] w-20 flex-none">
      <ResponsiveContainer height="100%" width="100%">
        <AreaChart data={data} margin={{ top: 3, right: 0, bottom: 3, left: 0 }}>
          <defs>
            <linearGradient id="wx-spark" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#8ea3ff" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#8ea3ff" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area dataKey="t" dot={false} fill="url(#wx-spark)" stroke="#8ea3ff" strokeWidth={1.8} type="monotone" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function StripSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-secondary px-4 py-2.5">
      <div className="skeleton-shimmer size-9 rounded-lg" />
      <div className="skeleton-shimmer h-8 w-10 rounded-lg" />
      <div className="flex flex-col gap-1.5">
        <div className="skeleton-shimmer h-3.5 w-28 rounded" />
        <div className="skeleton-shimmer h-3 w-40 rounded" />
      </div>
      <span className="flex-1" />
      <div className="skeleton-shimmer h-[26px] w-20 rounded" />
    </div>
  )
}
