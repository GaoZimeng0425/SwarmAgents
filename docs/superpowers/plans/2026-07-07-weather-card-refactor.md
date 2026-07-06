# Weather Card Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic dashboard weather card into a compact home-page strip plus a right-side detail drawer, backed by a new observed-`now` snapshot so 体感/能见度 have real data.

**Architecture:** One 383-line `weather-card.tsx` becomes four focused files (`weather-card` strip, `weather-drawer` Sheet shell, `weather-detail` body, `weather-shared` pure helpers) that all read the same `useWeather()` store — the strip is the sole fetch owner. A small backend addition fetches QWeather `/v7/weather/now` and adds a nullable `now` field to the forecast view-model.

**Tech Stack:** React 19, TypeScript, Zustand (`useWeather`), `@swarm/ui` (Sheet, ScrollArea, Button), recharts, Zod (`@swarm/protocol`), Vitest + Testing Library (jsdom).

## Global Constraints

- **Language:** code comments + commit messages in **English**; UI copy in Chinese (matches existing weather card).
- **No new dependencies** — recharts, jose, vaul are already present; add nothing.
- **Scroll:** every scroll container uses `ScrollArea` from `@/components/ui/scroll-area`; never raw `overflow-auto`.
- **Logging:** any changed main-process business path logs per AGENTS.md §5 (entry `info`, outcome `info` w/ `durationMs`, every `catch` `error`, branch surprises `warn`). Match `service.ts` shape.
- **Desktop tests:** run with `cd apps/desktop && npm test -- run <path>` (electron-as-node vitest). Renderer component tests **require** a `// @vitest-environment jsdom` pragma as line 1.
- **Full gate:** `npm test` (turbo) and `npm run typecheck` (turbo) from repo root must pass before completion.
- **jsdom caveats:** recharts `ResponsiveContainer` measures 0×0 in jsdom (charts render empty) — do **not** assert on chart contents in tests; assert on the text/tiles around them.
- **Worktree:** all work stays on branch `worktree-weather-card-refactor`; `node_modules` are symlinked from the main checkout.

---

### Task 1: Protocol — `WeatherNow` schema + `now` field

**Files:**
- Modify: `packages/protocol/src/types/weather.ts` (add `WeatherNow`; add `now` to `WeatherForecast` ~line 126-137)
- Test: `packages/protocol/src/types/weather.test.ts`

**Interfaces:**
- Produces: `WeatherNow` (Zod object + inferred type) and `WeatherForecast.now: WeatherNow | null`, consumed by Tasks 2, 3, 5, 7.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/types/weather.test.ts`:

```ts
import { WeatherForecast, WeatherNow } from './weather'

describe('WeatherNow', () => {
  const sampleNow = {
    temp: 28, feelsLike: 31, icon: '101', text: '多云', humidity: 58,
    windScale: '3', windDir: '东南风', windSpeed: 12, pressure: 1006,
    vis: 16, precip: 0, obsTime: '2026-07-07T10:00:00+08:00',
  }

  it('parses a full now snapshot', () => {
    expect(WeatherNow.parse(sampleNow)).toEqual(sampleNow)
  })

  it('rejects a malformed now (missing vis)', () => {
    const { vis: _drop, ...bad } = sampleNow
    expect(WeatherNow.safeParse(bad).success).toBe(false)
  })

  it('WeatherForecast accepts now: null and a full now', () => {
    const base = {
      location: '北京市', lng: 116.4, lat: 39.9, source: 'gps' as const,
      fetchedAt: 1, hours: [], warnings: [], indices: [], air: null, minutely: null,
    }
    expect(WeatherForecast.parse({ ...base, now: null }).now).toBeNull()
    expect(WeatherForecast.parse({ ...base, now: sampleNow }).now).toEqual(sampleNow)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run ../../packages/protocol/src/types/weather.test.ts`
(or from `packages/protocol`: `npx vitest run src/types/weather.test.ts`)
Expected: FAIL — `WeatherNow` is not exported / `now` unknown key.

- [ ] **Step 3: Add the schema + field**

In `packages/protocol/src/types/weather.ts`, add before `WeatherForecast`:

```ts
// Observed current conditions (/v7/weather/now). Distinct from hours[0], which
// is a *forecast* hour: `vis` (km) and `feelsLike` (°C) exist only here.
export const WeatherNow = z.object({
  temp: z.number(),
  feelsLike: z.number(),
  icon: z.string(),
  text: z.string(),
  humidity: z.number(),
  windScale: z.string(),
  windDir: z.string(),
  windSpeed: z.number(),
  pressure: z.number(),
  vis: z.number(),
  precip: z.number(),
  obsTime: z.string(),
})
export type WeatherNow = z.infer<typeof WeatherNow>
```

Then add `now` to the `WeatherForecast` object (alongside `air`/`minutely`):

```ts
  air: AirQuality.nullable(),
  minutely: Minutely.nullable(),
  now: WeatherNow.nullable(),
})
```

(`index.ts` re-exports via wildcard — no change needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run ../../packages/protocol/src/types/weather.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types/weather.ts packages/protocol/src/types/weather.test.ts
git commit -m "feat(weather): add WeatherNow snapshot to forecast view-model"
```

---

### Task 2: qweather.ts — `normalizeNow` + `fetchNow`

**Files:**
- Modify: `apps/desktop/src/main/weather/qweather.ts` (add `RawNow`, `normalizeNow`, `fetchNow`; add `now: null` to `fetchHourly`'s return object ~line 102-113)
- Test: `apps/desktop/src/main/weather/qweather.test.ts`

**Interfaces:**
- Consumes: `WeatherNow` (Task 1), existing `num`, `formatOffset`, `qwGet`.
- Produces: `normalizeNow(raw: RawNow | undefined): WeatherNow | null` and `fetchNow(config, lng, lat): Promise<WeatherNow | null>`, consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/main/weather/qweather.test.ts`:

```ts
import { normalizeNow } from './qweather'

describe('normalizeNow', () => {
  const raw = {
    obsTime: '2026-07-07T02:00+00:00',
    temp: '28', feelsLike: '31', icon: '101', text: '多云',
    humidity: '58', windScale: '3', windDir: '东南风', windSpeed: '12',
    pressure: '1006', vis: '16', precip: '0.0',
  }

  it('coerces numeric strings and keeps labels', () => {
    const n = normalizeNow(raw)
    expect(n).not.toBeNull()
    expect(n).toMatchObject({
      temp: 28, feelsLike: 31, humidity: 58, windSpeed: 12,
      pressure: 1006, vis: 16, precip: 0, windScale: '3',
      windDir: '东南风', icon: '101', text: '多云',
    })
    // obsTime is normalized to an ISO string with a local offset
    expect(typeof n?.obsTime).toBe('string')
  })

  it('returns null when raw is undefined', () => {
    expect(normalizeNow(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/main/weather/qweather.test.ts`
Expected: FAIL — `normalizeNow` not exported.

- [ ] **Step 3: Implement normalizeNow + fetchNow**

In `apps/desktop/src/main/weather/qweather.ts`:

Add `WeatherNow` to the type import from `@swarm/protocol`.

Add after the hourly section (reuse the same `num` + `formatOffset` + `new Date` tz trick as `normalizeHourly`):

```ts
// ── Current observation (/v7/weather/now) ──────────────────────────────────

type RawNow = {
  obsTime?: string
  temp?: string
  feelsLike?: string
  icon?: string
  text?: string
  humidity?: string
  windScale?: string
  windDir?: string
  windSpeed?: string
  pressure?: string
  vis?: string
  precip?: string
}

/** Convert a raw QWeather `now` object into WeatherNow (pure). null when absent. */
export function normalizeNow(raw: RawNow | undefined): WeatherNow | null {
  if (!raw || !raw.obsTime) return null
  const d = new Date(raw.obsTime)
  const obsTime = Number.isNaN(d.getTime())
    ? raw.obsTime
    : d.toString().includes('GMT')
      ? new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().replace('Z', formatOffset(d))
      : d.toISOString()
  return {
    temp: num(raw.temp),
    feelsLike: num(raw.feelsLike),
    icon: raw.icon ?? '',
    text: raw.text ?? '',
    humidity: num(raw.humidity),
    windScale: raw.windScale ?? '',
    windDir: raw.windDir ?? '',
    windSpeed: num(raw.windSpeed),
    pressure: num(raw.pressure),
    vis: num(raw.vis),
    precip: num(raw.precip),
    obsTime,
  }
}

// GET {host}/v7/weather/now?location=lng,lat → WeatherNow | null. Supplementary
// (non-fatal): the service treats a throw as `now = null`.
export async function fetchNow(config: WeatherConfig, lng: number, lat: number): Promise<WeatherNow | null> {
  const body = await qwGet(config, `/v7/weather/now?location=${lng},${lat}`)
  return normalizeNow(body.now as RawNow | undefined)
}
```

Then add `now: null` to the object returned by `fetchHourly` (so the base forecast satisfies the new required field):

```ts
    air: null,
    minutely: null,
    now: null,
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/main/weather/qweather.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/weather/qweather.ts apps/desktop/src/main/weather/qweather.test.ts
git commit -m "feat(weather): fetch + normalize /v7/weather/now observation"
```

---

### Task 3: service.ts — wire `fetchNow` into the fan-out

**Files:**
- Modify: `apps/desktop/src/main/weather/service.ts` (import `fetchNow` ~line 11; add to `Promise.all` ~line 166-184; combine + log ~line 185-196)
- Test: `apps/desktop/src/main/weather/service.test.ts`

**Interfaces:**
- Consumes: `fetchNow` (Task 2).
- Produces: `getForecast` results now carry `now` (populated on success, `null` on failure).

- [ ] **Step 1: Write the failing test**

Inspect the existing `service.test.ts` mock setup (it mocks `./qweather`). Add a case mirroring the existing `air` assertions: mock `fetchNow` to resolve a `WeatherNow`, assert the returned forecast's `now` matches; add a second case where `fetchNow` rejects and assert `now` is `null` while `hours` still populate. Use the same mock/spy style already in the file (do not invent a new harness).

Example shape (adapt to the file's existing mocking approach):

```ts
it('includes now on success and null when fetchNow throws', async () => {
  // ...existing mocks for fetchHourly etc...
  // fetchNow resolves a snapshot in the happy path:
  expect(result.now).toMatchObject({ temp: expect.any(Number), vis: expect.any(Number) })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/main/weather/service.test.ts`
Expected: FAIL — `now` is `undefined`/missing.

- [ ] **Step 3: Wire it in**

In `apps/desktop/src/main/weather/service.ts`:

Import: change line 11 to include `fetchNow`:

```ts
import { fetchAir, fetchHourly, fetchIndices, fetchMinutely, fetchNow, fetchWarnings } from './qweather'
```

Extend the `Promise.all` destructure + array (add a `now` entry after `minutely`):

```ts
        const [core, warnings, indices, air, minutely, now] = await Promise.all([
          fetchHourly({ config: state, lng: coordLng, lat: coordLat, source, locationLabel: label }),
          fetchWarnings(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather warnings fetch failed', err: errMsg(e) })
            return []
          }),
          fetchIndices(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather indices fetch failed', err: errMsg(e) })
            return []
          }),
          fetchAir(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather air fetch failed', err: errMsg(e) })
            return null
          }),
          fetchMinutely(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather minutely fetch failed', err: errMsg(e) })
            return null
          }),
          fetchNow(state, coordLng, coordLat).catch((e) => {
            log.warn({ msg: 'weather now fetch failed', err: errMsg(e) })
            return null
          }),
        ])
        const forecast = { ...core, warnings, indices, air, minutely, now }
```

Add `now: now !== null,` to the `log.info({ msg: 'weather fetched', ... })` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/main/weather/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/weather/service.ts apps/desktop/src/main/weather/service.test.ts
git commit -m "feat(weather): include now snapshot in getForecast fan-out"
```

---

### Task 4: `weather-shared.ts` — extract pure helpers

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/weather-shared.ts`
- Test: `apps/desktop/src/renderer/src/components/views/dashboard/weather-shared.test.ts`

**Interfaces:**
- Produces (all moved verbatim from today's `weather-card.tsx`): `weatherEmoji(code: string): string`, `aqiHex(category: string): string`, `severityHex(color: string): string`, `relativeTime(epochMs: number): string`, and the `TOOLTIP_STYLE` const. Consumed by Tasks 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Create `weather-shared.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { aqiHex, weatherEmoji } from './weather-shared'

describe('weatherEmoji', () => {
  it('maps clear/cloud/rain/snow ranges', () => {
    expect(weatherEmoji('100')).toBe('☀️')
    expect(weatherEmoji('101')).toBe('⛅')
    expect(weatherEmoji('305')).toBe('🌧️')
    expect(weatherEmoji('400')).toBe('🌨️')
  })
  it('falls back for unknown codes', () => {
    expect(weatherEmoji('zzz')).toBe('🌡️')
  })
})

describe('aqiHex', () => {
  it('returns distinct bands for 优 vs 良', () => {
    expect(aqiHex('优')).not.toBe(aqiHex('良'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-shared.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `weather-shared.ts` by moving these verbatim out of the current `weather-card.tsx`: `SEVERITY_HEX`, `severityHex`, `TOOLTIP_STYLE`, `weatherEmoji`, `aqiHex`, `relativeTime`. Export each. Header comment:

```ts
// Pure, JSX-free helpers shared by the weather strip, drawer, and detail body:
// icon-code → emoji, AQI/severity band colors, relative-time formatting, and the
// theme-aware recharts tooltip style. No React, no store access.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-shared.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/weather-shared.ts apps/desktop/src/renderer/src/components/views/dashboard/weather-shared.test.ts
git commit -m "refactor(weather): extract pure helpers to weather-shared"
```

---

### Task 5: `weather-detail.tsx` — full detail body

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/weather-detail.tsx`
- Test: `apps/desktop/src/renderer/src/components/views/dashboard/weather-detail.test.tsx`

**Interfaces:**
- Consumes: `useWeather()` (`forecast`), `weather-shared` helpers, `WeatherNow`/`AirQuality`/etc. from `@swarm/protocol`.
- Produces: `export function WeatherDetail(): React.JSX.Element` — reads the store, renders the full detail body. Consumed by Task 6.

**Content order (per spec §6):** WarningBanner → current block (from `now`, fallback `hours[0]`) → 4-tile grid (湿度/风/气压/能见度) → MinutelyStrip → AqiBlock → temp chart → pop chart → IndicesGrid.

- [ ] **Step 1: Write the failing test**

Create `weather-detail.test.tsx` (jsdom; mock `useWeather`):

```ts
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const forecast = {
  location: '北京市 · 朝阳区', lng: 116.4, lat: 39.9, source: 'gps' as const,
  fetchedAt: Date.now(), warnings: [], indices: [], air: null, minutely: null,
  now: {
    temp: 28, feelsLike: 31, icon: '101', text: '多云', humidity: 58,
    windScale: '3', windDir: '东南风', windSpeed: 12, pressure: 1006,
    vis: 16, precip: 0, obsTime: '2026-07-07T10:00:00+08:00',
  },
  hours: [{ time: '2026-07-07T10:00:00+08:00', tempC: 27, icon: '101', text: '多云', precipMm: 0, pop: 20, humidity: 58, windScale: '3', windDir: '东南风', pressure: 1006 }],
}

vi.mock('@/hooks/use-weather', () => ({ useWeather: () => ({ forecast, status: 'ready', config: {}, error: null, refresh: vi.fn(), clear: vi.fn() }) }))

afterEach(cleanup)

describe('WeatherDetail', () => {
  it('renders feels-like from now and the visibility tile', async () => {
    const { WeatherDetail } = await import('./weather-detail')
    render(<WeatherDetail />)
    expect(screen.getByText(/体感 31°/)).toBeInTheDocument()
    expect(screen.getByText(/能见度/)).toBeInTheDocument()
    expect(screen.getByText(/16km/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-detail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

Create `weather-detail.tsx`. Move these sub-components verbatim from the current `weather-card.tsx`: `WarningBanner`, `AqiPill`, `MinutelyStrip`, `AirTile`, `IndicesGrid`. Import helpers from `./weather-shared`. Read the store: `const { forecast } = useWeather()`. Guard: `if (!forecast) return <></>`. Compute `const cur = forecast.now`; fallback `const h0 = forecast.hours[0]`.

Body (JSX), in the spec order:

```tsx
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
              <Area dataKey="pop" fill="var(--primary)" fillOpacity={0.18} stroke="var(--primary)" strokeWidth={1.5} type="monotone" />
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
```

Imports at top:

```tsx
import type { AirQuality, Minutely, WeatherIndex, WeatherWarning } from '@swarm/protocol'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { useWeather } from '@/hooks/use-weather'
import { TOOLTIP_STYLE, aqiHex, severityHex, weatherEmoji } from './weather-shared'
```

(Keep the `useState` import for the moved `WarningBanner`/`IndicesGrid` which use local open-state.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-detail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/weather-detail.tsx apps/desktop/src/renderer/src/components/views/dashboard/weather-detail.test.tsx
git commit -m "feat(weather): weather-detail body rendering now + 4-tile grid + charts"
```

---

### Task 6: `weather-drawer.tsx` — right-side Sheet shell

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/weather-drawer.tsx`
- Test: `apps/desktop/src/renderer/src/components/views/dashboard/weather-drawer.test.tsx`

**Interfaces:**
- Consumes: `useWeather()` (`forecast`, `refresh`, `status`), `WeatherDetail` (Task 5), `relativeTime` (Task 4), `@swarm/ui` `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`, `ScrollArea` from `@/components/ui/scroll-area`.
- Produces: `export function WeatherDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element`. Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Create `weather-drawer.test.tsx`:

```ts
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const forecast = {
  location: '北京市 · 朝阳区', lng: 116.4, lat: 39.9, source: 'gps' as const,
  fetchedAt: Date.now(), warnings: [], indices: [], air: null, minutely: null,
  now: { temp: 28, feelsLike: 31, icon: '101', text: '多云', humidity: 58, windScale: '3', windDir: '东南风', windSpeed: 12, pressure: 1006, vis: 16, precip: 0, obsTime: '2026-07-07T10:00:00+08:00' },
  hours: [{ time: '2026-07-07T10:00:00+08:00', tempC: 27, icon: '101', text: '多云', precipMm: 0, pop: 20, humidity: 58, windScale: '3', windDir: '东南风', pressure: 1006 }],
}
vi.mock('@/hooks/use-weather', () => ({ useWeather: () => ({ forecast, status: 'ready', config: {}, error: null, refresh: vi.fn(), clear: vi.fn() }) }))

afterEach(cleanup)

describe('WeatherDrawer', () => {
  it('renders location + detail when open', async () => {
    const { WeatherDrawer } = await import('./weather-drawer')
    render(<WeatherDrawer onOpenChange={() => {}} open />)
    expect(screen.getByText(/北京市 · 朝阳区/)).toBeInTheDocument()
    expect(screen.getByText(/体感 31°/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-drawer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the drawer**

Create `weather-drawer.tsx`:

```tsx
// Right-side Sheet that shows the full weather detail. Presentation-only: reads
// the same useWeather() store as the strip (opening it never triggers a fetch);
// the ↻ button reuses the store's refresh(). Scroll uses ScrollArea per project rule.
import { RefreshCw } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@swarm/ui'

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
                <p className="mt-0.5 text-muted-foreground text-xs">
                  和风天气 · {relativeTime(forecast.fetchedAt)}
                </p>
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
        <ScrollArea className="min-h-0 flex-1 px-5 pb-6 pt-4">
          <WeatherDetail />
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
```

(Confirm `lucide-react` is already a dependency — it is used across the renderer. Confirm the exact `SheetContent`/`SheetHeader`/`SheetTitle` export names against `agent-form-sheet.tsx`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-drawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/weather-drawer.tsx apps/desktop/src/renderer/src/components/views/dashboard/weather-drawer.test.tsx
git commit -m "feat(weather): right-side detail drawer (Sheet + ScrollArea)"
```

---

### Task 7: `weather-card.tsx` — rewrite as the compact strip

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx`
- Test: `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.test.tsx`

**Interfaces:**
- Consumes: `useWeather()`, `useSettingsNav()`, `weather-shared` helpers, `WeatherDrawer` (Task 6), `@swarm/ui` `Button`, recharts `Line`/`LineChart`/`ResponsiveContainer` (sparkline only), lucide `ChevronRight`.
- Produces: `export function WeatherCard(): React.JSX.Element` — unchanged export consumed by `home-dashboard.tsx` (no mount-site change).

**Behavior:** sole fetch owner (mount `refresh()` + visibility auto-refresh, moved verbatim from today's card). Renders the compact strip; ready-strip click opens `<WeatherDrawer>`.

- [ ] **Step 1: Write the failing test**

Create `weather-card.test.tsx`:

```ts
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openSettings = vi.fn()
vi.mock('@/hooks/use-settings-nav', () => ({ useSettingsNav: () => ({ openSettings }) }))

let mockState: any
vi.mock('@/hooks/use-weather', () => ({ useWeather: () => mockState }))

const readyForecast = {
  location: '北京市 · 朝阳区', lng: 116.4, lat: 39.9, source: 'gps' as const,
  fetchedAt: Date.now(), warnings: [], indices: [], air: null, minutely: null,
  now: { temp: 28, feelsLike: 31, icon: '101', text: '多云', humidity: 58, windScale: '3', windDir: '东南风', windSpeed: 12, pressure: 1006, vis: 16, precip: 0, obsTime: '2026-07-07T10:00:00+08:00' },
  hours: [
    { time: '2026-07-07T10:00:00+08:00', tempC: 27, icon: '101', text: '多云', precipMm: 0, pop: 20, humidity: 58, windScale: '3', windDir: '东南风', pressure: 1006 },
    { time: '2026-07-07T11:00:00+08:00', tempC: 29, icon: '101', text: '多云', precipMm: 0, pop: 10, humidity: 55, windScale: '3', windDir: '东南风', pressure: 1005 },
  ],
}

afterEach(cleanup)
beforeEach(() => { openSettings.mockClear() })

describe('WeatherCard', () => {
  it('not-configured: click goes to settings, no drawer', async () => {
    mockState = { config: { projectId: '', credentialId: '', hasPrivateKey: false }, forecast: null, status: 'idle', error: null, refresh: vi.fn(), clear: vi.fn() }
    const { WeatherCard } = await import('./weather-card')
    render(<WeatherCard />)
    fireEvent.click(screen.getByText(/配置和风天气/))
    expect(openSettings).toHaveBeenCalledWith('weather')
  })

  it('ready: shows temp + opens drawer on click', async () => {
    mockState = { config: { projectId: 'p', credentialId: 'c', hasPrivateKey: true }, forecast: readyForecast, status: 'ready', error: null, refresh: vi.fn(), clear: vi.fn() }
    const { WeatherCard } = await import('./weather-card')
    render(<WeatherCard />)
    expect(screen.getByText('28°')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /北京市/ }))
    // drawer renders the detail's feels-like line
    expect(await screen.findByText(/体感 31°/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-card.test.tsx`
Expected: FAIL — current card has no compact strip / drawer.

- [ ] **Step 3: Rewrite the card**

Replace the entire `weather-card.tsx` with the compact strip. Keep the two `useEffect`s (mount `refresh()` + visibilitychange auto-refresh) verbatim. Delete the moved sub-components/helpers (now in `weather-detail`/`weather-shared`). New body:

```tsx
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

  return (
    <>
      <button
        className="flex w-full items-center gap-4 rounded-2xl border border-border bg-card px-5 py-3 text-left shadow-sm hover:border-foreground/20"
        onClick={() => setDrawerOpen(true)}
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
      <WeatherDrawer onOpenChange={setDrawerOpen} open={drawerOpen} />
    </>
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npm test -- run src/renderer/src/components/views/dashboard/weather-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx apps/desktop/src/renderer/src/components/views/dashboard/weather-card.test.tsx
git commit -m "feat(weather): compact home strip + drawer toggle, replacing the wall card"
```

---

### Task 8: Full verification + manual check

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS (no errors). If stale `.tsbuildinfo` reports fixed errors, `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete` and re-run.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS — including the new protocol, qweather, service, and four renderer test files.

- [ ] **Step 3: Lint the touched files**

Run: `npx biome check --write apps/desktop/src/renderer/src/components/views/dashboard/ apps/desktop/src/main/weather/qweather.ts apps/desktop/src/main/weather/service.ts packages/protocol/src/types/weather.ts`
Expected: no remaining diagnostics.

- [ ] **Step 4: Manual check via run-desktop skill**

Launch the app (run-desktop skill). On the home dashboard: the weather widget is a single compact row (not a wall). Click it → a right-side drawer slides in showing the warning banner (if any), big temp with 体感, the 湿度/风/气压/能见度 grid, air quality, and both trend charts. Close it. Compare against `docs/design/screenshots/dash-fit.png` and `docs/design/screenshots/dashboard-drawer.png`.

- [ ] **Step 5: Commit any lint fixups**

```bash
git add -A
git commit -m "chore(weather): lint fixups after refactor" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** §1 problem → Tasks 4-7 split; §3 module boundaries → Tasks 4/5/6/7 (one file each); §4 strip → Task 7; §5 backend `now` → Tasks 1/2/3; §6 drawer → Tasks 5/6; §7 testing → tests in every task + Task 8. All covered.
- **Type consistency:** `WeatherNow` (Task 1) fields match `normalizeNow`'s output (Task 2), the detail's `now.*` reads (Task 5), and test fixtures (Tasks 5/6/7). `WeatherDrawer` prop names (`open`, `onOpenChange`) match Task 7's usage.
- **No placeholders:** every code step shows full code; Task 3's test is described against the existing mock harness (which must be read, not invented) — the only step that adapts to existing structure rather than pasting a full block, because the file's mock style is the source of truth.
