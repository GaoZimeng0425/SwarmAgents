// Dashboard weather widget. Uses useWeather for config + forecast + status,
// runs renderer geolocation on mount + on a manual refresh, and renders current
// conditions plus temperature / precipitation-probability trend charts (recharts).
// When unconfigured, shows a guidance card that opens Settings → weather.
import { useEffect } from 'react'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { Button } from '@swarm/ui'
import { useWeather } from '@/hooks/use-weather'
import { useSettingsDialog } from '@/stores/settings-dialog'

export function WeatherCard(): React.JSX.Element {
  const { config, forecast, status, error, refresh } = useWeather()
  // openSettings('weather') targets the weather section. 'weather' joins the
  // SettingsSection union in Task 12 (Settings view wiring); until then this
  // is the single expected typecheck note in this file.
  const openSettings = useSettingsDialog((s) => s.openSettings)

  // Fetch on mount. The hook's refresh() handles geolocation + IPC.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Auto-refresh when the tab becomes visible and the cache is stale (>30min).
  useEffect(() => {
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        const age = forecast ? Date.now() - forecast.fetchedAt : Infinity
        if (age > 30 * 60_000) void refresh()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [forecast, refresh])

  const configured = !!config.projectId && !!config.credentialId && !!config.privateKeyPem
  if (!configured) {
    return (
      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-base">天气</h3>
            <p className="mt-1 text-muted-foreground text-sm">配置和风天气凭据后查看实时天气与逐小时预报。</p>
          </div>
          <Button onClick={() => openSettings('weather')} variant="outline">
            前往设置
          </Button>
        </div>
      </section>
    )
  }

  const current = forecast?.hours[0]
  const fmtHour = (iso: string): string => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:00`
  }
  const chartData =
    forecast?.hours.map((h) => ({
      hour: fmtHour(h.time),
      temp: h.tempC,
      pop: h.pop,
    })) ?? []

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      {/* Header: location + source + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span>📍 {forecast?.location ?? '定位中…'}</span>
          {forecast && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
              {forecast.source === 'gps' ? 'gps' : 'ip'}
            </span>
          )}
          {forecast && (
            <span className="text-muted-foreground text-xs">· {relativeTime(forecast.fetchedAt)}</span>
          )}
        </div>
        <button
          className="text-muted-foreground text-xs hover:text-foreground"
          disabled={status === 'locating' || status === 'fetching'}
          onClick={() => void refresh()}
          type="button"
        >
          ↻ 刷新
        </button>
      </div>

      {/* Body: state machine */}
      {(status === 'locating' || status === 'fetching') && <WeatherSkeleton />}
      {status === 'error' && (
        <div className="py-8 text-center">
          <p className="text-destructive text-sm">{error ?? '天气获取失败'}</p>
          <button className="mt-2 text-xs underline" onClick={() => void refresh()} type="button">
            重试
          </button>
        </div>
      )}
      {status === 'ready' && current && (
        <div className="mt-3 space-y-4">
          {/* Current conditions */}
          <div className="flex items-center gap-4">
            <span className="text-4xl">{current.icon}</span>
            <div>
              <div className="font-semibold text-3xl">{Math.round(current.tempC)}°</div>
              <div className="text-muted-foreground text-sm">
                {current.text} · 体感 {Math.round(current.feelsLikeC)}°
              </div>
              <div className="text-muted-foreground text-xs">
                💧 {current.pop}% · 🌬 {current.windScale}级 {current.windDir} · 气压 {current.pressure}
              </div>
            </div>
          </div>

          {/* Temperature trend */}
          <div>
            <p className="mb-1 text-muted-foreground text-xs">24h 温度趋势</p>
            <div className="h-24">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                  <XAxis dataKey="hour" fontSize={10} interval={3} stroke="var(--muted-foreground)" tickLine={false} />
                  <YAxis fontSize={10} stroke="var(--muted-foreground)" tickLine={false} unit="°" width={40} />
                  <CartesianGrid horizontal={false} stroke="var(--border)" />
                  <Tooltip />
                  <Line dataKey="temp" dot={false} stroke="var(--foreground)" strokeWidth={2} type="monotone" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Precipitation probability */}
          <div>
            <p className="mb-1 text-muted-foreground text-xs">24h 降水概率</p>
            <div className="h-20">
              <ResponsiveContainer height="100%" width="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -28 }}>
                  <XAxis dataKey="hour" fontSize={10} interval={3} stroke="var(--muted-foreground)" tickLine={false} />
                  <YAxis fontSize={10} stroke="var(--muted-foreground)" tickLine={false} unit="%" width={40} />
                  <CartesianGrid horizontal={false} stroke="var(--border)" />
                  <Tooltip />
                  <Area
                    dataKey="pop"
                    fill="var(--primary)"
                    fillOpacity={0.18}
                    stroke="var(--primary)"
                    strokeWidth={1.5}
                    type="monotone"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function WeatherSkeleton(): React.JSX.Element {
  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-4">
        <div className="h-10 w-10 animate-pulse rounded bg-muted" />
        <div className="space-y-2">
          <div className="h-6 w-16 animate-pulse rounded bg-muted" />
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="h-24 w-full animate-pulse rounded bg-muted" />
    </div>
  )
}

function relativeTime(epochMs: number): string {
  const sec = Math.floor((Date.now() - epochMs) / 1000)
  if (sec < 60) return '刚刚更新'
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  return `${Math.floor(sec / 3600)} 小时前`
}
