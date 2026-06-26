import { useEffect, useState } from 'react'
import type { UsageRange, UsageStats } from '@shared/types/usage'
import {
  Activity,
  BarChart3,
  CalendarCheck,
  CalendarDays,
  DatabaseZap,
  Flame,
  MessageSquare,
  MessagesSquare,
} from 'lucide-react'
import { Bar, BarChart, Cell, Line, LineChart, Pie, PieChart, XAxis } from 'recharts'

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { swarmApi } from '@/lib/api'
import { formatCost, formatCount, heatmapShade } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

const SHADE_CLASS = ['bg-muted', 'bg-primary/30', 'bg-primary/50', 'bg-primary/70', 'bg-primary'] as const
const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

function ActivityHeatmap({ days }: { days: { date: string; tokens: number }[] }): React.JSX.Element {
  const max = Math.max(0, ...days.map((d) => d.tokens))
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">活跃热力图</h3>
      {/* 52-week (one year) grid; column-major 7-row fill = one column per week.
          Wider than the card on narrow windows, so scroll the grid horizontally. */}
      <TooltipProvider>
        <ScrollArea>
          <div className="flex items-center justify-center">
            <div className="grid w-max grid-flow-col grid-rows-7 gap-1 pb-2">
              {days.map((d) => (
                <Tooltip key={d.date}>
                  <TooltipTrigger
                    className={cn('h-3 w-3 rounded-[3px]', SHADE_CLASS[heatmapShade(d.tokens, max)])}
                    render={<div />}
                  />
                  <TooltipContent className="flex-col items-start gap-0.5">
                    <span>{d.date}</span>
                    <span>{formatCount(d.tokens)} tokens</span>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </TooltipProvider>
      <div className="mt-2 flex items-center justify-end gap-1 text-muted-foreground text-xs">
        <span>较少</span>
        {SHADE_CLASS.map((c) => (
          <span className={cn('h-3 w-3 rounded-[3px]', c)} key={c} />
        ))}
        <span>较多</span>
      </div>
    </div>
  )
}

function DailyTokenChart({ daily }: { daily: { date: string; tokens: number }[] }): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">按天 Token 趋势</h3>
      <ChartContainer className="h-[220px] w-full" config={{ tokens: { label: 'tokens', color: 'var(--chart-1)' } }}>
        <BarChart data={daily}>
          <XAxis dataKey="date" hide />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="tokens" fill="var(--color-tokens)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

function ModelTrendChart({
  daily,
  byModel,
  dailyByModel,
}: {
  daily: { date: string; tokens: number }[]
  byModel: { model: string; tokens: number; pct: number }[]
  dailyByModel: { date: string; model: string; tokens: number }[]
}): React.JSX.Element {
  const models = byModel.map((m) => m.model)
  // Pivot the sparse (date, model, tokens) rows into wide rows keyed by date,
  // over `daily`'s zero-filled date axis so gaps render as 0 per model.
  const tokensByDate = new Map<string, Record<string, number>>()
  for (const r of dailyByModel) {
    const row = tokensByDate.get(r.date) ?? {}
    row[r.model] = r.tokens
    tokensByDate.set(r.date, row)
  }
  const data = daily.map((d) => {
    const row: Record<string, number | string> = { date: d.date }
    const cells = tokensByDate.get(d.date)
    for (const model of models) row[model] = cells?.[model] ?? 0
    return row
  })
  const config = Object.fromEntries(
    models.map((m, i) => [m, { label: m, color: SLICE_COLORS[i % SLICE_COLORS.length] }])
  )
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">按模型 Token 趋势</h3>
      <ChartContainer className="h-[240px] w-full" config={config}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <ChartTooltip content={<ChartTooltipContent />} />
          {models.map((m, i) => (
            <Line
              dataKey={m}
              dot={false}
              key={m}
              stroke={SLICE_COLORS[i % SLICE_COLORS.length]}
              strokeWidth={2}
              type="monotone"
            />
          ))}
          <ChartLegend content={<ChartLegendContent />} />
        </LineChart>
      </ChartContainer>
    </div>
  )
}

function ModelUsageDonut({
  byModel,
  total,
}: {
  byModel: { model: string; tokens: number; usdCents: number; pct: number }[]
  total: number
}): React.JSX.Element {
  const chartConfig = Object.fromEntries(
    byModel.map((m, i) => [m.model, { label: m.model, color: SLICE_COLORS[i % SLICE_COLORS.length] }])
  )
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">模型用量</h3>
      <div className="flex items-center gap-6">
        <ChartContainer className="h-[200px] w-[200px]" config={chartConfig}>
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={byModel} dataKey="tokens" innerRadius={60} nameKey="model" outerRadius={90} strokeWidth={2}>
              {byModel.map((m, i) => (
                <Cell fill={SLICE_COLORS[i % SLICE_COLORS.length]} key={m.model} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <ul className="flex flex-1 flex-col gap-2">
          {byModel.map((m, i) => (
            <li className="flex items-center gap-2 text-sm" key={m.model}>
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
              />
              <span className="flex-1">{m.model}</span>
              <span className="text-muted-foreground">{formatCount(m.tokens)} tokens</span>
              <span className="w-16 text-right tabular-nums">{formatCost(m.usdCents)}</span>
              <span className="w-12 text-right">{total > 0 ? m.pct : 0}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center gap-2 text-muted-foreground text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div className="font-semibold text-3xl tracking-tight">{value}</div>
      {sub ? <div className="mt-1 text-muted-foreground text-xs">{sub}</div> : null}
    </div>
  )
}

export function UsageView(): React.JSX.Element {
  const [rangeDays, setRangeDays] = useState<UsageRange>(30)
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setStats(null)
    setLoading(true)
    setError(null)
    swarmApi
      .getUsageStats(rangeDays)
      .then((s) => {
        if (active) setStats(s)
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [rangeDays])

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
        <header className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">时间范围</h2>
          <div className="flex rounded-lg border p-0.5">
            {([7, 30] as const).map((r) => (
              <button
                className={cn(
                  'rounded-md px-3 py-1 text-sm transition-colors',
                  rangeDays === r ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                )}
                key={r}
                onClick={() => setRangeDays(r)}
                type="button"
              >
                最近 {r} 天
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <div className="rounded-lg border border-destructive/40 p-4 text-destructive text-sm">{error}</div>
        ) : null}
        {loading && !stats ? <div className="text-muted-foreground text-sm">加载中…</div> : null}
        {stats && stats.totals.tokens === 0 ? (
          <div className="rounded-lg border p-8 text-center text-muted-foreground text-sm">还没有用量数据</div>
        ) : null}

        {stats ? (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <StatCard icon={<Flame size={15} />} label="tokens 用量" value={formatCount(stats.totals.tokens)} />
            <StatCard
              icon={<DatabaseZap size={15} />}
              label="缓存命中 token"
              sub={
                stats.totals.tokens > 0 ? (
                  <span>命中率 {Math.round((stats.totals.cacheRead / stats.totals.tokens) * 100)}%</span>
                ) : undefined
              }
              value={formatCount(stats.totals.cacheRead)}
            />
            <StatCard
              icon={<BarChart3 size={15} />}
              label="花费"
              sub={<span className="rounded bg-muted px-1.5 py-0.5">估算 · 自定义模型价格可能不准</span>}
              value={formatCost(stats.totals.usdCents)}
            />
            <StatCard icon={<MessagesSquare size={15} />} label="会话数量" value={String(stats.totals.sessions)} />
            <StatCard icon={<MessageSquare size={15} />} label="消息数量" value={String(stats.totals.messages)} />
            <StatCard icon={<CalendarDays size={15} />} label="活跃天数" value={String(stats.totals.activeDays)} />
            <StatCard
              icon={<CalendarCheck size={15} />}
              label="当前连续天数"
              value={String(stats.totals.currentStreak)}
            />
            <StatCard
              icon={<Activity size={15} />}
              label="最常用模型"
              sub={stats.totals.topModel ? `占比 ${stats.totals.topModel.pct}%` : undefined}
              value={stats.totals.topModel?.model ?? '—'}
            />
          </section>
        ) : null}
        {stats && stats.totals.tokens > 0 ? (
          <>
            <ActivityHeatmap days={stats.heatmap} />
            <DailyTokenChart daily={stats.daily} />
            <ModelTrendChart byModel={stats.byModel} daily={stats.daily} dailyByModel={stats.dailyByModel} />
            <ModelUsageDonut byModel={stats.byModel} total={stats.totals.tokens} />
          </>
        ) : null}
      </div>
    </ScrollArea>
  )
}
