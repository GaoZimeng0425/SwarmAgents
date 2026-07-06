// Dashboard weather widget — compact strip. Sole fetch owner (geolocation on
// mount + visibility auto-refresh). Overview only; clicking opens WeatherDrawer
// for the full detail. Unconfigured → a one-row link into Settings → weather.
import { useEffect, useState } from 'react'
import { Button } from '@swarm/ui'
import { ChevronRight } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer } from 'recharts'

import { useSettingsNav } from '@/hooks/use-settings-nav'
import { useWeather } from '@/hooks/use-weather'
import { WeatherDrawer } from './weather-drawer'
import { aqiHex, weatherEmoji } from './weather-shared'

export function WeatherCard(): React.JSX.Element {
  const { config, forecast, status, error, refresh } = useWeather()
  const { openSettings } = useSettingsNav()
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        const age = forecast ? Date.now() - forecast.fetchedAt : Number.POSITIVE_INFINITY
        if (age > 30 * 60_000) void refresh()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [forecast, refresh])

  const configured = !!config.projectId && !!config.credentialId && config.hasPrivateKey
  if (!configured) {
    return (
      <button
        className="flex w-full items-center justify-between rounded-2xl border border-border bg-card px-5 py-3 text-left shadow-sm hover:border-foreground/20"
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
  if (status === 'locating' || status === 'fetching') return <StripSkeleton />

  if (status === 'error') {
    return (
      <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-5 py-3 shadow-sm">
        <span className="text-destructive text-sm">{error ?? '天气获取失败'}</span>
        <Button onClick={() => void refresh()} size="sm" variant="ghost">
          重试
        </Button>
      </div>
    )
  }

  if (!forecast) return <StripSkeleton />

  const now = forecast.now
  const h0 = forecast.hours[0]
  const temp = Math.round(now?.temp ?? h0?.tempC ?? 0)
  const text = now?.text ?? h0?.text ?? ''
  const icon = now?.icon ?? h0?.icon ?? ''
  const pop = h0?.pop ?? 0
  const spark = forecast.hours.map((h) => ({ t: h.tempC }))
  const warning = forecast.warnings[0]
  const extraWarnings = forecast.warnings.length - 1

  return (
    <button
      className="flex w-full items-center gap-4 rounded-2xl border border-border bg-card px-5 py-3 text-left shadow-sm hover:border-foreground/20"
      onClick={onOpenDrawer}
      type="button"
    >
      <span className="text-3xl">{weatherEmoji(icon)}</span>
      <span className="font-semibold text-2xl tabular-nums">{temp}°</span>
      <div className="min-w-0">
        <div className="truncate font-medium text-sm">{forecast.location}</div>
        <div className="truncate text-muted-foreground text-xs">
          {text} · 降水 {pop}%
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {warning && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 text-xs dark:text-amber-400">
            ⚠ {warning.typeName}预警
            {extraWarnings > 0 && ` +${extraWarnings}`}
          </span>
        )}
        {forecast.air && (
          <span
            className="rounded-full border px-2 py-0.5 font-semibold text-xs"
            style={{ color: aqiHex(forecast.air.category), borderColor: aqiHex(forecast.air.category) }}
          >
            AQI {forecast.air.category} {forecast.air.aqi}
          </span>
        )}
        {spark.length > 1 && (
          <div className="h-8 w-[72px]">
            <ResponsiveContainer height="100%" width="100%">
              <LineChart data={spark} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
                <Line dataKey="t" dot={false} stroke="var(--muted-foreground)" strokeWidth={1.5} type="monotone" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <ChevronRight className="size-4 text-muted-foreground" />
      </div>
    </button>
  )
}

function StripSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-border bg-card px-5 py-3 shadow-sm">
      <div className="size-8 animate-pulse rounded bg-muted" />
      <div className="h-7 w-12 animate-pulse rounded bg-muted" />
      <div className="space-y-1.5">
        <div className="h-3.5 w-28 animate-pulse rounded bg-muted" />
        <div className="h-3 w-20 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}
