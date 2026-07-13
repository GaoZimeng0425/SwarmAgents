# Weather Card Refactor — Compact Strip + Detail Drawer

**Status:** Approved (brainstorming complete)
**Date:** 2026-07-07
**Branch:** `worktree-weather-card-refactor`
**Scope:** Refactor the dashboard weather widget to match the `天气卡片重构` /
`天气详情` design drafts. Split the single 383-line `weather-card.tsx` into a
compact home-page strip plus a right-side detail drawer, and add a real
current-observation snapshot (`now`) so the design's 体感 / 能见度 fields have
data.

Supersedes the rendering half of `2026-07-06-weather-dashboard-design.md`
(§8.3). The main-process module boundary, JWT signing, geolocation, caching,
and IPC from that spec are unchanged and remain in force.

---

## 1. Problem (First Principles)

The current `weather-card.tsx` conflates two responsibilities:

1. **Overview** — a glanceable summary that belongs on the crowded home
   dashboard alongside the composer, running cards, and scheduled tasks.
2. **Full detail** — warnings, current conditions, a 4-metric grid, minutely
   precipitation, air quality, two trend charts, and life indices.

Cramming both into one card turns the home page into a weather wall: the single
most space-hungry widget dominates a dashboard whose primary job is launching
and monitoring agent runs. The design drafts fix this by **separating the two
concerns**: a compact strip on the home page (`dash-fit.png`, layout `1a`)
that, on click, opens a right-side drawer with everything (`dashboard-drawer.png`,
`detail-charts.png`).

A second, quieter mismatch: the design's "current conditions" block shows 体感
(feels-like) and 能见度 (visibility). These are **observed-now** values, not
forecast values — and the view-model currently has neither. Rendering current
conditions from `hours[0]` (a forecast hour) is the wrong source for a "right
now" panel. The fix is to fetch QWeather's `/v7/weather/now` observation and add
a `now` snapshot to the view-model; the detail panel renders from `now`, with
`hours[0]` as a graceful fallback.

---

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Home widget | Compact horizontal strip (design `1a`) | Reclaims vertical space; overview-only |
| Detail surface | Right-side `Sheet` (design drawer) | Matches draft; reuses `@swarm/ui` `Sheet`, same pattern as `agent-form-sheet.tsx` |
| Shared state | Both read the same `useWeather()` store | No forecast prop-drilling; single fetch owner |
| Current conditions source | New `now` observation snapshot | 体感/能见度 need `/v7/weather/now`; semantically correct for "now" |
| 4-tile grid | 湿度 / 风 / 气压 / 能见度 | All four now have real data |
| Scroll | `ScrollArea` inside the drawer | Project rule: never raw `overflow-auto` |
| Charts | Keep existing recharts `LineChart` + `AreaChart`, moved into detail | No new deps; already approved |

---

## 3. Module Boundaries (Renderer)

The one file splits into four, each with a single purpose:

```
apps/desktop/src/renderer/src/components/views/dashboard/
  weather-card.tsx     ← Compact strip ONLY. Owns: mount fetch, visibility
                          auto-refresh, drawer open/close state. Renders the
                          four states (not-configured / loading / error / ready).
  weather-drawer.tsx   ← <Sheet side="right"> shell + <ScrollArea>. Reads the
                          same useWeather() store; renders <WeatherDetail>.
                          Owns the manual ↻ refresh button + freshness line.
  weather-detail.tsx   ← Full detail body (moved verbatim from today's card):
                          WarningBanner, current block, 4-tile grid,
                          MinutelyStrip, AqiBlock, temp chart, pop chart,
                          IndicesGrid. Reads useWeather() for `forecast`.
  weather-shared.ts    ← Pure helpers, no JSX: weatherEmoji, aqiHex,
                          severityHex, relativeTime, TOOLTIP_STYLE.
```

**Data flow:** `weather-card.tsx` is the sole fetch owner (`useWeather().refresh()`
on mount + on `visibilitychange` when stale). `weather-drawer.tsx` and
`weather-detail.tsx` are presentation-only readers of the same store — opening
the drawer never triggers a second fetch. The manual refresh in the drawer calls
the same `refresh()`.

**What does NOT change:** `useWeather` hook, `stores/weather.ts`, all of
`main/weather/*` except `qweather.ts` (see §5), `weather-view.tsx` (Settings),
IPC, and the `home-dashboard.tsx` mount point (still `<WeatherCard />`).

---

## 4. Compact Strip (`weather-card.tsx`)

Layout `1a` from `dash-fit.png`:

```
┌────────────────────────────────────────────────────────────────────────┐
│ ⛅  28°   北京市 · 朝阳区          [⚠ 高温预警] [AQI 良 78]  ‹sparkline›  › │
│           多云 · 降水 20%                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

- The **entire row is a `<button>`** → opens the drawer. `rounded-2xl border
  border-border bg-card`, matching sibling dashboard cards. One-row height
  (~64px), not the current tall block.
- **Left cluster:** `weatherEmoji(now.icon)` + big `{round(now.temp)}°`.
- **Middle:** line 1 `{location}` (already includes district); line 2 muted
  `{now.text} · 降水 {hours[0].pop}%`.
- **Right cluster (only what fits):**
  - `⚠ {typeName}预警` amber pill — shown only if `warnings.length > 0` (first
    warning; if multiple, `+N`).
  - `AQI {category} {aqi}` colored pill — only if `air`.
  - Mini sparkline: recharts `Line` of `hours[].tempC`, **no axes / grid /
    tooltip / dots**, ~72px × 32px, `stroke="var(--muted-foreground)"`. Hidden
    when `hours.length < 2`.
  - Chevron `›` (lucide `ChevronRight`) affording "opens detail".
- **States:**
  | `status` | Strip |
  |---|---|
  | not-configured | Single row: "天气 · 配置和风天气凭据 →" → `openSettings('weather')` (no drawer) |
  | locating / fetching | Skeleton row (emoji block + two text bars) |
  | error | "天气获取失败 · 重试" inline; 重试 calls `refresh()` |
  | ready | Strip as above; click → drawer |

The strip prefers `now` for the temperature/text; if `now` is null (supplementary
endpoint failed) it falls back to `hours[0]`.

---

## 5. Backend: `now` Observation Snapshot

### 5.1 Protocol (`packages/protocol/src/types/weather.ts`)

Add a `WeatherNow` schema and a nullable `now` on the forecast:

```ts
// Observed current conditions (/v7/weather/now). Distinct from hours[0], which
// is a *forecast* hour. `vis` (km) and `feelsLike` (°C) exist only here.
export const WeatherNow = z.object({
  temp: z.number(),
  feelsLike: z.number(),
  icon: z.string(),
  text: z.string(),
  humidity: z.number(),   // %
  windScale: z.string(),  // Beaufort as string
  windDir: z.string(),
  windSpeed: z.number(),  // km/h
  pressure: z.number(),   // hPa
  vis: z.number(),        // km
  precip: z.number(),     // mm, last hour
  obsTime: z.string(),    // ISO, local tz
})
export type WeatherNow = z.infer<typeof WeatherNow>
```

Add to `WeatherForecast`: `now: WeatherNow.nullable()`. Like `air`/`minutely`,
it is `null` when the `/v7/weather/now` call fails — the core hourly forecast
still renders. `index.ts` re-export unchanged (wildcard).

### 5.2 `main/weather/qweather.ts`

Follow the existing supplementary-endpoint pattern (the module already fans out
to air / minutely / warnings / indices and tolerates individual failures):

- Add `fetchNow(cfg, lng, lat)` → `GET {host}/v7/weather/now?location={lng},{lat}`
  with the same `Bearer` JWT. On `code === "200"`, normalize `resp.now` into
  `WeatherNow` (convert `obsTime` UTC→local, coerce numeric strings via
  `Number(...)`, matching how `hours` are normalized).
- Wire it into the same `Promise.allSettled` (or equivalent) fan-out that
  gathers air/minutely; on rejection set `now = null` and log a `warn`
  (branch surprise), consistent with §10 of the prior spec.
- Pure module: no side effects beyond fetch; `service.ts` owns logging of the
  aggregate outcome.

### 5.3 Tests (`main/weather/qweather.test.ts`)

- Normalize a sample `/v7/weather/now` payload → expected `WeatherNow`
  (UTC→local `obsTime`; numeric-string coercion for `temp`/`vis`/`pressure`).
- Non-`200` now-response → `now` is `null`, other sections still populate.
- Protocol test: `WeatherForecast` parses with `now: null` and with a full
  `now`.

---

## 6. Detail Drawer (`weather-drawer.tsx` + `weather-detail.tsx`)

`weather-drawer.tsx` — the shell (per `dashboard-drawer.png`):

```tsx
<Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent side="right" className="w-[440px] sm:max-w-[440px] p-0">
    <SheetHeader> 📍 {location}  ·  和风天气 · {relativeTime}   ↻ </SheetHeader>
    <ScrollArea className="h-full px-5 pb-6">
      <WeatherDetail />
    </ScrollArea>
  </SheetContent>
</Sheet>
```

- Width ~`440px`. Header holds location, freshness line, and the manual refresh.
- **Scroll uses `ScrollArea`** (project rule) — never `overflow-y-auto`.

`weather-detail.tsx` — body order matches `detail-charts.png`:

1. **WarningBanner** (if `warnings.length`) — reuse today's component, amber
   left-border, expandable text.
2. **Current block** — `weatherEmoji(now.icon)` (5xl) + `{round(now.temp)}°C`
   + `{now.text} · 体感 {round(now.feelsLike)}°`. Falls back to `hours[0]`
   (no 体感) if `now` is null.
3. **4-tile grid** — 湿度 `{now.humidity}%` / 风 `{now.windScale}级 {now.windDir}`
   / 气压 `{now.pressure}` / 能见度 `{now.vis}km`. Bordered tiles, matching the
   draft's icon+value+label cells.
4. **MinutelyStrip** (if `minutely`) — reuse today's component.
5. **AqiBlock** (if `air`) — reuse today's `AirTile`, styled per the draft's
   空气质量 block (AQI badge + pollutant grid).
6. **Temperature trend** — existing `LineChart`, moved verbatim.
7. **Precipitation probability** — existing `AreaChart`, moved verbatim.
8. **IndicesGrid** (if `indices.length`) — reuse today's component.

All sub-components (`WarningBanner`, `AqiPill`, `MinutelyStrip`, `AirTile`,
`IndicesGrid`, `WeatherSkeleton`) move from `weather-card.tsx` into
`weather-detail.tsx`; their pure helpers move to `weather-shared.ts`.

---

## 7. Testing Strategy

| Layer | Test |
|---|---|
| `protocol/weather.ts` | `WeatherForecast` parses with `now` present and `now: null`; `WeatherNow` rejects malformed. |
| `qweather.ts` | `fetchNow` normalization (tz + numeric coercion); non-200 → `now: null` without failing the aggregate. |
| `weather-card.tsx` | Renders each state (not-configured/loading/error/ready); ready-strip click sets drawer open; not-configured click calls `openSettings`. |
| `weather-detail.tsx` | Renders current block from `now`; falls back to `hours[0]` when `now` is null; 4-tile grid shows humidity/wind/pressure/vis. |

Reuse the existing `weather-card.test.tsx` scaffolding if present; otherwise add
focused renderer tests with a mocked `useWeather`.

Manual integration: with real credentials, the home strip shows current temp +
badges + sparkline; clicking opens the drawer with full detail; 体感 and 能见度
show real values.

---

## 8. Out of Scope

- No change to geolocation, JWT, caching, IPC, or the Settings weather view.
- No new dependencies (recharts, jose, vaul already present).
- No daily/weekly forecast, no multi-location, no map.
- Other design surfaces (首页 Dashboard overall polish, 统一命令台, Settings,
  Service Views) are explicitly deferred to their own rounds.

---

## 9. Open Questions

None — the 体感/能见度 data gap is resolved by the `now` snapshot (§5).
