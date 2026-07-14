# Weather Dashboard Card — QWeather Grid-Hourly Forecast

**Status:** Proposed
**Date:** 2026-07-06
**Scope:** Add a QWeather (和风天气) powered weather card to the desktop app's
home dashboard. The card auto-locates the user (GPS with IP fallback), fetches
the 24-hour grid-point hourly forecast, and renders it with current conditions
plus temperature / precipitation trend charts.

---

## 1. Background & Motivation

The desktop app already integrates several external services (Gmail, web-search,
calendar, providers) behind a uniform pattern: an encrypted on-disk store +
a service state machine + IPC handlers + a settings view. This feature adds
**weather** as another such module.

Data source: **QWeather "Grid Hourly Forecast"** API
(`GET /v7/grid-forecast/24h?location=lng,lat`) — grid-based numerical forecast,
3–5 km resolution, global coverage, UTC timestamps. Authentication is **JWT
signed with an Ed25519 private key** (`sub` = Project ID, `kid` = Credential ID).
A suitable key pair already exists in the repo root as untracked files
(`ed25519-private.pem` / `ed25519-public.pem`); these are pasted into Settings
at runtime — code never reads them directly.

---

## 2. Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Feature form | Dashboard weather card (display only) | Passive consumption; no agent tool |
| Geolocation | **Hybrid**: Geolocation API → IP fallback | Robust; graceful degradation |
| Config storage | **A1** single encrypted `weather.enc` (safeStorage) | Matches gmail/web-search pattern exactly |
| Trend chart | **B2** `recharts` | Chosen by user; +1 dependency (~150kb) |
| JWT signing | **C2** `jose` library | Reliable; +1 dependency (~50kb) |
| Cache | 30-min in-memory, keyed by rounded coords | Avoids hammering quota; no disk |
| Card content | Detailed (current + 24h trends) | User choice |
| IP fallback service | `ip-api.com/json` | Free, no key, exact fields needed |
| GPS reverse geocode | QWeather GeoAPI (`/geo/v2/city/lookup`) | Chinese label, same provider |

**Dependency tradeoff acknowledged:** `recharts` + `jose` are new runtime
dependencies, which conflicts with AGENTS.md §2 ("no extra dependencies"). The
user explicitly approved both during brainstorming. The spec records this so it
is a conscious, not accidental, choice.

---

## 3. Architecture & Module Boundaries

The new `weather` module mirrors the proven `web-search` module end-to-end.

```
packages/protocol/src/weather.ts          ← Zod schemas (config + view-model)
packages/protocol/src/index.ts            ← re-export

apps/desktop/src/main/weather/
  store.ts        ← safeStorage-encrypted weather.enc (template: web-search/store.ts)
  jwt.ts          ← signQWeatherJwt() — EdDSA/Ed25519 via jose
  geo.ts          ← locateByIp() + reverseGeocode() (QWeather GeoAPI)
  qweather.ts     ← fetchGridHourly() — pure fetch + normalize
  service.ts      ← createService: getConfig/setConfig/getForecast(+cache)

apps/desktop/src/main/ipc/swarm-ipc.ts    ← register weather:* handlers
apps/desktop/src/main/index.ts            ← bootstrap store+service

apps/desktop/src/renderer/src/stores/weather.ts          ← zustand store
apps/desktop/src/renderer/src/components/views/weather-view.tsx        ← Settings form
apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx  ← dashboard card
apps/desktop/src/renderer/src/components/views/home-dashboard.tsx       ← mount card
apps/desktop/src/renderer/src/stores/settings-dialog.ts                ← + 'weather' section
apps/desktop/src/renderer/src/components/settings-dialog.tsx           ← + Weather row

apps/desktop/package.json                 ← + recharts, + jose
```

**Boundary rule:** the main process is the **sole** keeper of the private key
and the **sole** issuer of outbound HTTP requests to QWeather/ip-api. The
renderer never sees the PEM, never signs JWTs, and never calls QWeather
directly — it receives only the normalized `WeatherForecast` view-model over
IPC. This matches how providers/gmail keep secrets out of the renderer.

**Geo boundary:** `navigator.geolocation` runs in the renderer (it needs DOM +
the OS permission prompt); the resulting coordinates are passed to main as IPC
arguments. Main owns the IP fallback (plain `fetch`, no CORS concerns in main).

---

## 4. Data Model (`packages/protocol/src/weather.ts`)

```ts
// ── Config (encrypted on disk) ─────────────────────────────────────────────
export const WeatherConfig = z.object({
  host: z.string().url().default('https://devapi.qweather.com'),
  projectId: z.string().default(''),        // JWT sub
  credentialId: z.string().default(''),     // JWT kid
  privateKeyPem: z.string().default(''),    // PEM content as a string (not a path)
})
export type WeatherConfig = z.infer<typeof WeatherConfig>
export const defaultWeatherConfig = (): WeatherConfig => ({
  host: 'https://devapi.qweather.com', projectId: '', credentialId: '', privateKeyPem: '',
})

export const WeatherConfigOnDisk = z.object({ weather: WeatherConfig })
export type WeatherConfigOnDisk = z.infer<typeof WeatherConfigOnDisk>
export const defaultWeatherConfigOnDisk = (): WeatherConfigOnDisk => ({ weather: defaultWeatherConfig() })

// ── Forecast view-model (IPC → renderer; never the raw QWeather payload) ────
export const WeatherHour = z.object({
  time: z.string(),        // ISO 8601, already converted to local timezone for display
  tempC: z.number(),
  icon: z.string(),        // QWeather icon code, e.g. "100"
  text: z.string(),        // human label, e.g. "晴"
  precipMm: z.number(),
  pop: z.number(),         // probability of precipitation, %. Defaults to 0 when absent.
  humidity: z.number(),
  windScale: z.string(),   // Beaufort scale as string, e.g. "3"
  windDir: z.string(),     // e.g. "NE"
  pressure: z.number(),    // hPa
  feelsLikeC: z.number(),
})
export type WeatherHour = z.infer<typeof WeatherHour>

export const WeatherForecast = z.object({
  location: z.string(),           // reverse-geocoded label, e.g. "北京市"
  lng: z.number(),
  lat: z.number(),
  source: z.enum(['gps', 'ip']),  // which locator won
  fetchedAt: z.number(),          // epoch ms — for cache + freshness display
  hours: z.array(WeatherHour).max(24),
})
export type WeatherForecast = z.infer<typeof WeatherForecast>
```

**Notes:**
- A **view-model**, not the raw QWeather payload, crosses the IPC boundary.
  Renderer is insulated from QWeather field renames; the normalizer is unit-testable.
- Timestamps are converted to local timezone during normalization so the
  renderer does no timezone math.
- `pop` (precipitation probability) is **not guaranteed** by the grid-hourly
  endpoint; when absent for an hour it normalizes to `0`. This is a known
  limitation, surfaced in the card's tooltip rather than hidden.
- `index.ts` re-exports all of the above.

---

## 5. JWT Signing & QWeather Request

### 5.1 `weather/jwt.ts`

```ts
import { SignJWT, exportJWK } from 'jose'
import { createPrivateKey } from 'node:crypto'
import type { WeatherConfig } from '@swarm/protocol'

// Build a short-lived QWeather JWT: alg=EdDSA, kid=credentialId, sub=projectId, exp=5m.
export async function signQWeatherJwt(cfg: WeatherConfig): Promise<string> {
  const keyObj = createPrivateKey({ key: cfg.privateKeyPem, format: 'pem' })
  const jwk = await exportJWK(keyObj)              // jose needs JWK for Ed25519
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: cfg.credentialId })
    .setSubject(cfg.projectId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(jwk)
}
```

Validation: `projectId`, `credentialId`, and `privateKeyPem` must all be
non-empty before signing — enforced in `service.ts` (returns `{ok:false,
code:'invalid'}`) so `jwt.ts` assumes a configured state.

### 5.2 `weather/qweather.ts`

```ts
export async function fetchGridHourly(opts: {
  config: WeatherConfig
  lng: number; lat: number
  source: 'gps' | 'ip'
  locationLabel: string
}): Promise<WeatherForecast>
```

- Endpoint: `GET {config.host}/v7/grid-forecast/24h?location={lng},{lat}`
  (longitude first, per QWeather convention).
- Header: `Authorization: Bearer <jwt from signQWeatherJwt>`.
- Success: response JSON `code === "200"`. Otherwise throw with the QWeather
  error code/message.
- Normalizes the raw `hourly` array into `WeatherHour[]`, converting each
  `fxTime` (UTC) to local-timezone ISO and mapping fields.
- Pure module: no logging, no globals — logging happens in `service.ts`.

### 5.3 `weather/geo.ts`

```ts
// IP fallback via ip-api.com. Main-process fetch. Returns {lng,lat,city} or throws.
export async function locateByIp(): Promise<{ lng: number; lat: number; city: string }>
// URL: http://ip-api.com/json/?fields=query,lat,lon,city  (HTTP ok in main; 5s AbortController timeout)

// Reverse geocode via QWeather GeoAPI; returns e.g. "北京市" or throws.
export async function reverseGeocode(cfg: WeatherConfig, lng: number, lat: number): Promise<string>
// URL: GET {host}/geo/v2/city/lookup?location=lng,lat  (Bearer JWT; first match's name)
```

---

## 6. Service (`weather/service.ts`)

```ts
export type Service = {
  getConfig(): WeatherConfig
  setConfig(c: WeatherConfig): Promise<SetResult>   // {ok:true} | {ok:false,code:'invalid'|'persist_failed',message}
  // lng/lat null (or undefined) → IP fallback. Returns forecast or throws.
  getForecast(lng: number | null, lat: number | null): Promise<WeatherForecast>
  onConfigChanged(cb: (c: WeatherConfig) => void): () => void
}
```

**`getForecast` flow:**
1. Validate config (projectId/credentialId/privateKeyPem non-empty); else throw
   a typed error the renderer maps to a "not configured" state.
2. Resolve coordinates:
   - If `lng`/`lat` provided (GPS path) → `reverseGeocode(cfg, lng, lat)` for
     the label; `source = 'gps'`.
   - Else → `locateByIp()` → coords + city label; `source = 'ip'`.
3. Cache check: key = `lng.toFixed(2),lat.toFixed(2)`. If cached entry exists
   and `now - fetchedAt < 30min`, return it.
4. Cache miss → `fetchGridHourly(...)`, store in cache, return.
5. **Logging (AGENTS.md §5):**
   - `info` entry: `{msg:'weather fetch', lng, lat, source, component:'weather-service'}`
   - `info` outcome: `{msg:'weather fetched', durationMs, hours, cached:false}`
   - `warn` cache hit: `{msg:'weather cache hit', ageMs}`
   - `error` on any throw: `{msg:'weather fetch failed', err, ...}` before rethrow.

Cache is a single in-memory slot (`{ key, forecast } | null`). No disk
persistence; cleared on app restart. Coordinate drift > 0.01° produces a new
key, so a moved user gets fresh data.

---

## 7. IPC (`swarm-ipc.ts` additions)

```ts
ipcMain.handle('weather:getConfig', () => weatherService.getConfig())
ipcMain.handle('weather:setConfig', (_e, c) => weatherService.setConfig(c))
ipcMain.handle('weather:getForecast', (_e, lng, lat) => weatherService.getForecast(lng, lat))
```

Preload exposes these as `window.api.weather.*` (mirror how web-search/gmail
are exposed). The renderer store calls them via `window.api.weather`.

Bootstrap in `main/index.ts`: instantiate `createStore({filePath})` +
`createService({store})`, then pass the service into the IPC registration,
alongside the existing services.

---

## 8. Renderer

### 8.1 Store (`stores/weather.ts`)

A zustand store holding `{ config, forecast, status, error }`. `status` ∈
`'idle' | 'locating' | 'fetching' | 'ready' | 'error'`. Actions: `loadConfig`,
`saveConfig`, `refresh(lng?, lat?)`, `locateAndRefresh()`.

### 8.2 Settings View (`views/weather-view.tsx`)

Template: `views/web-search-view.tsx`. Four fields:
- **Host** — text input, default `https://devapi.qweather.com`.
- **Project ID** — text input.
- **Credential ID** — text input.
- **Private Key PEM** — `<textarea>` for pasting PEM content. Helper text:
  *"Paste the contents of your ed25519-private.pem."*
Save button → `weather:setConfig`; result toast on error. A "test" affordance
is **not** included (YAGNI — the dashboard card itself is the test).

### 8.3 Dashboard Card (`views/dashboard/weather-card.tsx`)

```
┌─────────────────────────────────────────────┐
│ 📍 北京市          gps · 刚刚更新 ↻          │
│                                             │
│   ☀️  24°                                    │
│   晴 · 体感 22°                              │
│   💧35%  🌬3级 NE  气压1013                  │
│                                             │
│  📈 24h 温度趋势                             │
│  ┌───────────────────────────────────┐      │
│  │      recharts LineChart            │      │
│  └───────────────────────────────────┘      │
│  📈 24h 降水概率                             │
│  ┌───────────────────────────────────┐      │
│  │      recharts AreaChart (pop%)     │      │
│  └───────────────────────────────────┘      │
└─────────────────────────────────────────────┘
```

- **Current conditions** come from `hours[0]` (the grid-hourly endpoint has no
  separate "now"; the first hour is the current hour).
- **Source badge** (`gps`/`ip`) reflects `forecast.source`.
- **Refresh ↻** button + auto-refresh when the card becomes visible and the
  cache is stale (>30 min) — uses `document.visibilitychange`.
- recharts uses only `LineChart` + `AreaChart`, styled with existing CSS
  variables (`var(--foreground)`, `var(--muted)`, …); no recharts theme import.

**State → UI:**
| `status` | Rendered |
|---|---|
| `idle` (not configured) | Guidance card: "前往设置配置和风天气" button → opens Settings → weather |
| `locating` / `fetching` | Skeleton |
| `error` | Error message + Retry button (the error is the IPC throw; service already logged it) |
| `ready` | Card as above |

### 8.4 Settings dialog wiring

- `stores/settings-dialog.ts`: add `'weather'` to the `SettingsSection` union
  and to the `SECTIONS` array (positioned near other integrations, e.g. after
  `'web-search'`).
- `components/settings-dialog.tsx`: add a row to `SECTIONS` with an icon
  (e.g. `Cloud` from lucide) + the `WeatherView` component.

### 8.5 Dashboard mount

`components/views/home-dashboard.tsx`: render `<WeatherCard />` alongside the
existing dashboard widgets.

---

## 9. Geolocation Flow (cross-process)

```
WeatherCard mount
  → navigator.geolocation.getCurrentPosition({timeout: 8000})
      ├─ success → coords {lng, lat}
      │   → window.api.weather.getForecast(lng, lat)   // source='gps'
      │   → main: reverseGeocode → fetchGridHourly
      └─ fail/deny/timeout → window.api.weather.getForecast(null, null)
          → main: locateByIp() → fetchGridHourly       // source='ip'
          └─ ip-api fail too → throw → card shows "定位失败" error state
```

- Geolocation denial is **silent** (no alert); it just falls through to IP.
- ip-api uses a 5s `AbortController` timeout; on timeout/throw the card shows
  the error state with a retry.

---

## 10. Error Handling & Logging

Every business path in `weather/service.ts` is logged per AGENTS.md §5:
- Entry at `info` with correlation fields (`lng`, `lat`, `source`).
- Outcome at `info` with `durationMs`.
- Every `catch` at `error` (`{msg, err, ...ctx}`) before rethrow/return.
- Cache hits at `warn` (a branch surprise worth surfacing for debugging quota).

The renderer's error state displays the message from the thrown error; the
user-visible copy is generic ("天气获取失败，请重试"), while the log retains the
precise cause for diagnosis.

---

## 11. Testing Strategy

| Layer | Test |
|---|---|
| `protocol/weather.ts` | Schema parse/defaults; rejects malformed config. |
| `weather/qweather.ts` | Normalize a sample QWeather payload → expected `WeatherForecast` (UTC→local tz, `pop` default 0). Non-`200` code throws. |
| `weather/jwt.ts` | Signed JWT has correct header (`alg:EdDSA`, `kid`), claim `sub=projectId`, verifies with the public key. |
| `weather/geo.ts` | Mock fetch for ip-api + QWeather GeoAPI; assert normalized output + timeout behavior. |
| `weather/service.ts` | Config validation; cache hit returns same object within TTL; cache miss calls fetch; coordinates rounding key. |
| `weather-view.tsx` | Renders fields; save calls IPC with parsed values. |
| `weather-card.tsx` | State machine: idle/locating/ready/error renders; refresh button calls store. |

Integration (manual): with real credentials pasted, the dashboard card shows
current conditions + trends.

---

## 12. Out of Scope

- No agent tool exposure (display only — confirmed in brainstorming).
- No disk caching of forecasts (in-memory only).
- No daily/weekly forecast (grid-**hourly** only, per the request).
- No multi-location support (single current location).
- No map view.
- The repo-root `ed25519-*.pem` files are **not** read by code; they are
  pasted into Settings. They remain untracked and are the user's credential.

---

## 13. Open Questions

None — all decisions resolved during brainstorming. (See §2 for the recorded
tradeoffs, especially the recharts + jose dependency choice.)
