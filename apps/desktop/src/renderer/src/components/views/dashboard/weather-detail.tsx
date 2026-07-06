// Full weather detail body: warning banner → current conditions (from the
// observed `now` snapshot, falling back to `hours[0]`) → 4-tile metric grid →
// minutely precipitation → air quality → temperature/pop trend charts → life
// indices. Hosted inside the weather drawer (Task 6). Reads useWeather() directly.

import { useState } from 'react'
import type { AirQuality, Minutely, WeatherIndex, WeatherWarning } from '@swarm/protocol'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { useWeather } from '@/hooks/use-weather'
import { aqiHex, severityHex, TOOLTIP_STYLE, weatherEmoji } from './weather-shared'

export function WeatherDetail(): React.JSX.Element {
  const { forecast } = useWeather()
  if (!forecast) return <></>
  const now = forecast.now
  const h0 = forecast.hours[0]
  const temp = now?.temp ?? h0?.tempC ?? 0
  const text = now?.text ?? h0?.text ?? ''
  const icon = now?.icon ?? h0?.icon ?? ''
  const chartData = forecast.hours.map((h) => ({ hour: fmtHour(h.time), temp: h.tempC, pop: h.pop }))

  return (
    <div className="space-y-4">
      {forecast.warnings.length > 0 && <WarningBanner warnings={forecast.warnings} />}

      {/* Current block */}
      <div className="flex items-center gap-4">
        <span className="text-5xl">{weatherEmoji(icon)}</span>
        <div>
          <div className="font-semibold text-4xl tabular-nums">{Math.round(temp)}°C</div>
          <div className="text-muted-foreground text-sm">
            {text}
            {now ? ` · 体感 ${Math.round(now.feelsLike)}°` : ''}
          </div>
        </div>
      </div>

      {/* 4-tile grid — only when the observation is present */}
      {now && (
        <div className="grid grid-cols-4 gap-2">
          <MetricTile label="湿度" value={`${now.humidity}%`} />
          <MetricTile label="风" value={`${now.windScale}级 ${now.windDir}`} />
          <MetricTile label="气压" value={`${now.pressure}`} />
          <MetricTile label="能见度" value={`${now.vis}km`} />
        </div>
      )}

      {forecast.minutely && <MinutelyStrip minutely={forecast.minutely} />}
      {forecast.air && <AirTile air={forecast.air} />}

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

      {forecast.indices.length > 0 && <IndicesGrid indices={forecast.indices} />}
    </div>
  )
}

function MetricTile({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="font-semibold text-sm tabular-nums">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  )
}

function fmtHour(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:00`
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
