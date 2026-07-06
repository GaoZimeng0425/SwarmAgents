// Dashboard weather widget. Uses useWeather for config + forecast + status,
// runs renderer geolocation on mount + on a manual refresh, and renders current
// conditions plus temperature / precipitation-probability trend charts (recharts).
// When unconfigured, shows a guidance card that opens Settings → weather.

import { useEffect, useState } from 'react'
import type { AirQuality, Minutely, WeatherIndex, WeatherWarning } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { useWeather } from '@/hooks/use-weather'
import { useSettingsDialog } from '@/stores/settings-dialog'

// Severity color per QWeather `severityColor` (semantic, theme-independent).
const SEVERITY_HEX: Record<string, string> = {
  Yellow: '#c99700',
  Blue: '#2f6bd8',
  Orange: '#e2650f',
  Red: '#d92d20',
  White: '#6b7280',
}
const severityHex = (c: string): string => SEVERITY_HEX[c] ?? '#6b7280'

// Theme-aware recharts tooltip (the default renders white-on-white in dark mode).
const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    fontSize: '12px',
    padding: '6px 10px',
    boxShadow: '0 4px 12px rgb(0 0 0 / 0.18)',
  },
  labelStyle: { color: 'var(--popover-foreground)', fontWeight: 600, marginBottom: '2px' },
  itemStyle: { color: 'var(--popover-foreground)' },
  cursor: { stroke: 'var(--border)', strokeWidth: 1 },
} as const

// Map a QWeather icon code (e.g. "302") to an emoji. Codes are grouped by range
// per the QWeather icon set: 1xx clear/cloud, 3xx rain, 4xx snow, 5xx fog/haze.
function weatherEmoji(code: string): string {
  const n = Number(code)
  if (!Number.isFinite(n)) return '🌡️'
  if (n === 100) return '☀️'
  if (n === 150) return '🌙' // 晴 (night)
  if (n >= 101 && n <= 103) return '⛅' // 多云/少云/晴间多云
  if (n >= 151 && n <= 153) return '⛅'
  if (n === 104 || n === 154) return '☁️' // 阴
  if (n >= 300 && n <= 303) return n >= 302 ? '⛈️' : '🌦️' // 阵雨/雷阵雨
  if (n === 304) return '⛈️' // 雷阵雨伴冰雹
  if (n >= 305 && n <= 399) return '🌧️' // 各类雨
  if (n >= 400 && n <= 499) return '🌨️' // 雪
  if (n >= 500 && n <= 515) return '🌫️' // 雾/霾/沙尘
  if (n === 900) return '🥵'
  if (n === 901) return '🥶'
  return '🌡️'
}

// CN AQI category → representative band color.
function aqiHex(category: string): string {
  if (category === '优') return '#4a9e46'
  if (category === '良') return '#b78a00'
  if (category.includes('轻度')) return '#e2650f'
  if (category.includes('中度')) return '#d92d20'
  if (category.includes('重度') || category.includes('严重')) return '#8b1a1a'
  return '#6b7280'
}

export function WeatherCard(): React.JSX.Element {
  const { config, forecast, status, error, refresh } = useWeather()
  const openSettings = useSettingsDialog((s) => s.openSettings)

  // Fetch on mount. The hook's refresh() handles geolocation + IPC.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Auto-refresh when the tab becomes visible and the cache is stale (>30min).
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
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">{forecast.source}</span>
          )}
          {forecast && <span className="text-muted-foreground text-xs">· {relativeTime(forecast.fetchedAt)}</span>}
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
      {status === 'ready' && forecast && current && (
        <div className="mt-3 space-y-4">
          {/* Active warnings (most important — surfaced first). Guard against a
              stale main process that predates these fields (dev version skew). */}
          {(forecast.warnings ?? []).length > 0 && <WarningBanner warnings={forecast.warnings ?? []} />}

          {/* Current conditions */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="text-4xl">{weatherEmoji(current.icon)}</span>
              <div>
                <div className="font-semibold text-3xl">{Math.round(current.tempC)}°</div>
                <div className="text-muted-foreground text-sm">{current.text}</div>
                <div className="text-muted-foreground text-xs">
                  💧 {current.pop}% · ☔ {current.precipMm}mm · 🌬 {current.windScale}级 {current.windDir} · 气压{' '}
                  {current.pressure}
                </div>
              </div>
            </div>
            {forecast.air && <AqiPill air={forecast.air} />}
          </div>

          {/* Minutely precipitation nowcast */}
          {forecast.minutely && <MinutelyStrip minutely={forecast.minutely} />}

          {/* Temperature trend */}
          <div>
            <p className="mb-1 text-muted-foreground text-xs">24h 温度趋势</p>
            <div className="h-24">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="hour" fontSize={10} interval={3} stroke="var(--muted-foreground)" tickLine={false} />
                  <YAxis fontSize={10} stroke="var(--muted-foreground)" tickLine={false} unit="°" width={34} />
                  <CartesianGrid horizontal={false} stroke="var(--border)" />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`${v}°`, '温度']} />
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
                <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="hour" fontSize={10} interval={3} stroke="var(--muted-foreground)" tickLine={false} />
                  <YAxis fontSize={10} stroke="var(--muted-foreground)" tickLine={false} unit="%" width={34} />
                  <CartesianGrid horizontal={false} stroke="var(--border)" />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`${v}%`, '降水概率']} />
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

          {/* Air quality */}
          {forecast.air && <AirTile air={forecast.air} />}

          {/* Life indices */}
          {(forecast.indices ?? []).length > 0 && <IndicesGrid indices={forecast.indices ?? []} />}
        </div>
      )}
    </section>
  )
}

function WarningBanner({ warnings }: { warnings: WeatherWarning[] }): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(warnings[0]?.id ?? null)
  return (
    <div className="space-y-2">
      {warnings.map((w) => {
        const hex = severityHex(w.severityColor)
        const open = openId === w.id
        return (
          <button
            className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-left"
            key={w.id}
            onClick={() => setOpenId(open ? null : w.id)}
            style={{ borderLeftWidth: 3, borderLeftColor: hex }}
            type="button"
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 flex-none rounded-full" style={{ backgroundColor: hex }} />
              <span className="flex-1 font-semibold text-sm">
                {w.typeName}
                {w.level}预警
              </span>
              <span
                className="flex-none rounded-full px-1.5 py-0.5 font-medium text-white text-xs"
                style={{ backgroundColor: hex }}
              >
                {w.level}
              </span>
            </div>
            {open && <p className="mt-1.5 text-muted-foreground text-xs">{w.text}</p>}
          </button>
        )
      })}
    </div>
  )
}

function AqiPill({ air }: { air: AirQuality }): React.JSX.Element {
  const hex = aqiHex(air.category)
  return (
    <span
      className="flex-none rounded-full border px-2.5 py-1 font-semibold text-xs"
      style={{ color: hex, borderColor: hex, backgroundColor: `${hex}1f` }}
    >
      AQI {air.aqi} · {air.category}
    </span>
  )
}

function MinutelyStrip({ minutely }: { minutely: Minutely }): React.JSX.Element {
  const max = Math.max(...minutely.points.map((p) => p.precipMm), 0.5)
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <p className="mb-2 font-medium text-sm">☔ {minutely.summary || '未来 2 小时降水'}</p>
      <div className="flex h-8 items-end gap-0.5">
        {minutely.points.map((p) => (
          <div
            className="flex-1 rounded-t-sm"
            key={p.time}
            style={{
              height: p.precipMm === 0 ? '3px' : `${Math.max(12, (p.precipMm / max) * 100)}%`,
              backgroundColor: p.precipMm === 0 ? 'var(--border)' : 'var(--primary)',
              opacity: p.precipMm === 0 ? 0.5 : 0.85,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>现在</span>
        <span>+1h</span>
        <span>+2h</span>
      </div>
    </div>
  )
}

function AirTile({ air }: { air: AirQuality }): React.JSX.Element {
  const hex = aqiHex(air.category)
  const pollutants: [string, number, boolean][] = [
    ['PM2.5', air.pm2p5, air.primary === 'PM2.5'],
    ['PM10', air.pm10, false],
    ['O₃', air.o3, air.primary === 'O3'],
    ['NO₂', air.no2, false],
    ['SO₂', air.so2, false],
    ['CO', air.co, false],
  ]
  return (
    <div>
      <p className="mb-1 text-muted-foreground text-xs">空气质量</p>
      <div className="flex items-center gap-4 rounded-xl border border-border bg-muted/40 p-3">
        <div className="flex-none border-border border-r pr-4 text-center">
          <div className="font-bold text-2xl tabular-nums" style={{ color: hex }}>
            {air.aqi}
          </div>
          <div className="font-medium text-xs" style={{ color: hex }}>
            {air.category}
          </div>
        </div>
        <div className="grid flex-1 grid-cols-3 gap-x-3 gap-y-1 text-xs tabular-nums">
          {pollutants.map(([k, v, pri]) => (
            <div key={k}>
              <span className="text-muted-foreground" style={pri ? { color: hex } : undefined}>
                {k}
                {pri ? '·主' : ''}
              </span>{' '}
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function IndicesGrid({ indices }: { indices: WeatherIndex[] }): React.JSX.Element {
  const [openType, setOpenType] = useState<string | null>(null)
  const openText = indices.find((i) => i.type === openType)?.text
  return (
    <div>
      <p className="mb-1 text-muted-foreground text-xs">生活指数</p>
      <div className="grid grid-cols-3 gap-2">
        {indices.map((i) => (
          <button
            className="rounded-lg border border-border p-2 text-left hover:border-foreground/30"
            key={i.type}
            onClick={() => setOpenType(openType === i.type ? null : i.type)}
            type="button"
          >
            <div className="text-muted-foreground text-xs">{i.name.replace('指数', '')}</div>
            <div className="font-semibold text-sm">{i.category}</div>
          </button>
        ))}
      </div>
      {openText && <p className="mt-2 text-muted-foreground text-xs">{openText}</p>}
    </div>
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
