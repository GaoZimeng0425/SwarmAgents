# Weather Dashboard Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a QWeather (和风天气) powered weather card to the desktop dashboard that auto-locates the user (GPS with IP fallback), fetches the 24-hour grid-point hourly forecast, and renders current conditions plus temperature / precipitation trend charts.

**Architecture:** A new `weather` main-process module cloned from the proven `web-search` module pattern — encrypted `weather.enc` store (safeStorage) + service state machine + dedicated `weather/ipc.ts` handlers + a renderer hook (`use-weather`) + a Settings view (`weather-view`) + a dashboard `WeatherCard`. The main process is the sole keeper of the Ed25519 private key and sole issuer of outbound HTTP. Renderer receives only a normalized `WeatherForecast` view-model over IPC. Geolocation runs in the renderer (needs the OS prompt) and coordinates are passed to main as IPC args; main owns the IP fallback.

**Tech Stack:** Electron (main + preload + renderer), React 19, zustand-free hook state (matches web-search), Zod (protocol schemas), `jose` (EdDSA/Ed25519 JWT signing — the only new dependency), `recharts` (already a direct dep at `^3.9.2`), Tailwind v4 + `@swarm/ui` primitives, `vitest` for tests.

## Global Constraints

- **Conversation language:** Chinese; **all code comments and commit messages in English** (AGENTS.md §0).
- **Logging:** every business path logs via `createLogger({ process: 'main' }).child({ component: 'weather-...' })` — entry at `info`, outcome at `info` with `durationMs`, every `catch` at `error` with `{msg, err, ...ctx}`, cache hits at `warn` (AGENTS.md §5). Structured first arg, never string interpolation. Never log secrets.
- **Test runner:** `vitest` (workspace root `pnpm --filter @swarm/desktop run test`; specs run from `apps/desktop`). Run a single spec with `pnpm --filter @swarm/desktop exec vitest run <path>`.
- **Typecheck:** `pnpm --filter @swarm/desktop run typecheck` (runs both `typecheck:node` and `typecheck:web`). Full repo: `pnpm typecheck`.
- **Boundary check:** `pnpm check-boundaries` — `@swarm/protocol` and `@swarm/shared` must import nothing platform-bound (no node/electron/react). Weather schemas live in protocol → pure zod only.
- **Dependencies:** add only `jose` to `apps/desktop/package.json` `dependencies`. `recharts` already present. Pin `jose` to the latest 5.x (`^5.9.6` or newer at install time).
- **Surgical changes (AGENTS.md §3):** every changed line traces to the weather feature. No incidental refactors. Match existing style.
- **`paths` helper:** new file paths go through `apps/desktop/src/main/constants.ts` `paths` object (e.g. `weather: () => join(app.getPath('userData'), 'weather.enc')`), matching `webSearch`/`gmail`/`calendar`.
- **Commit messages:** conventional-commits English, e.g. `feat(weather): ...`, `test(weather): ...`, `docs(weather): ...`.

## File Structure

Files are grouped by the layer they belong to; tasks build bottom-up so each task's tests run against real (earlier) code.

**Protocol (pure zod, no platform imports):**
- Create `packages/protocol/src/types/weather.ts` — `WeatherConfig`, `WeatherConfigOnDisk`, `WeatherForecast`, `WeatherHour` schemas + defaults.
- Modify `packages/protocol/src/types/index.ts` — re-export weather types.
- Modify `packages/protocol/src/types/ui.ts` — add `WeatherSetResult`, `WeatherBridge`, and `weather: WeatherBridge` on `SwarmBridge`.

**Main process (sole secret + HTTP keeper):**
- Create `apps/desktop/src/main/weather/store.ts` — safeStorage `weather.enc` store (clone of `web-search/store.ts`).
- Create `apps/desktop/src/main/weather/jwt.ts` — `signQWeatherJwt(cfg)` via jose.
- Create `apps/desktop/src/main/weather/qweather.ts` — `fetchGridHourly(...)` + `normalizeHourly(...)` pure normalizer.
- Create `apps/desktop/src/main/weather/geo.ts` — `locateByIp()`, `reverseGeocode(...)`.
- Create `apps/desktop/src/main/weather/service.ts` — `createService({store})` with `getConfig`/`setConfig`/`getForecast` + 30-min cache.
- Create `apps/desktop/src/main/weather/ipc.ts` — `wireWeatherIpc({service})` registering `weather:getConfig`/`setConfig`/`getForecast`.
- Create `apps/desktop/src/main/weather/index.ts` — `initWeather()` returning `{ service, dispose }`.
- Modify `apps/desktop/src/main/constants.ts` — add `weather: () => join(app.getPath('userData'), 'weather.enc')` to `paths`.
- Modify `apps/desktop/src/main/index.ts` — import `initWeather`, call it, dispose on quit. (No `swarm-ipc.ts` change — weather does not inject into the Agent Service.)

**Preload (contextBridge):**
- Modify `apps/desktop/src/preload/index.ts` — add `WEATHER_FORECAST_CHANNEL`/`onForecast` + `weather` bridge object + mount on `swarm`.

**Renderer (display only; receives view-models):**
- Create `apps/desktop/src/renderer/src/hooks/use-weather.ts` — config + forecast hook (clone shape of `use-web-search.ts`, extended for forecast).
- Create `apps/desktop/src/renderer/src/components/views/weather-view.tsx` — Settings form (clone of `web-search-view.tsx` structure).
- Create `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx` — the dashboard card (geolocation + recharts trends + state machine).
- Modify `apps/desktop/src/renderer/src/stores/settings-dialog.ts` — add `'weather'` to union + `SECTIONS`.
- Modify `apps/desktop/src/renderer/src/components/settings-dialog.tsx` — add Weather row to `SECTIONS`.
- Modify `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx` — mount `<WeatherCard />`.

**Dependency:**
- Modify `apps/desktop/package.json` — add `jose`.

---

## Task 1: Protocol schemas (pure zod)

**Files:**
- Create: `packages/protocol/src/types/weather.ts`
- Modify: `packages/protocol/src/types/index.ts`
- Modify: `packages/protocol/src/types/ui.ts`
- Test: `packages/protocol/src/types/weather.test.ts`

**Interfaces:**
- Consumes: nothing (pure zod).
- Produces: `WeatherConfig`, `WeatherConfigOnDisk`, `WeatherForecast`, `WeatherHour`, `defaultWeatherConfig`, `defaultWeatherConfigOnDisk` — all consumed by main store/service and renderer hook; `WeatherSetResult`, `WeatherBridge` consumed by preload + renderer.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/types/weather.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  WeatherConfig,
  WeatherConfigOnDisk,
  WeatherForecast,
  WeatherHour,
  defaultWeatherConfig,
  defaultWeatherConfigOnDisk,
} from './weather'

describe('WeatherConfig', () => {
  it('uses defaults for an empty object', () => {
    const c = WeatherConfig.parse({})
    expect(c).toEqual({
      host: 'https://devapi.qweather.com',
      projectId: '',
      credentialId: '',
      privateKeyPem: '',
    })
  })

  it('accepts a fully populated config', () => {
    const c = WeatherConfig.parse({
      host: 'https://api.qweather.com',
      projectId: 'proj_123',
      credentialId: 'cred_456',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nfoo\n-----END PRIVATE KEY-----\n',
    })
    expect(c.projectId).toBe('proj_123')
    expect(c.host).toBe('https://api.qweather.com')
  })

  it('rejects a non-URL host', () => {
    expect(() => WeatherConfig.parse({ host: 'not-a-url' })).toThrow()
  })
})

describe('defaultWeatherConfigOnDisk', () => {
  it('wraps the default config under `weather`', () => {
    expect(defaultWeatherConfigOnDisk()).toEqual({ weather: defaultWeatherConfig() })
  })

  it('round-trips through WeatherConfigOnDisk', () => {
    const parsed = WeatherConfigOnDisk.parse(defaultWeatherConfigOnDisk())
    expect(parsed.weather.host).toBe('https://devapi.qweather.com')
  })
})

describe('WeatherHour', () => {
  it('normalizes a complete hour', () => {
    const h = WeatherHour.parse({
      time: '2026-07-06T14:00+08:00',
      tempC: 24,
      icon: '100',
      text: '晴',
      precipMm: 0,
      pop: 10,
      humidity: 35,
      windScale: '3',
      windDir: 'NE',
      pressure: 1013,
      feelsLikeC: 22,
    })
    expect(h.tempC).toBe(24)
  })

  it('rejects a missing tempC', () => {
    expect(() => WeatherHour.parse({ time: 'x' })).toThrow()
  })
})

describe('WeatherForecast', () => {
  it('accepts a forecast with hours', () => {
    const f = WeatherForecast.parse({
      location: '北京市',
      lng: 116.4,
      lat: 39.9,
      source: 'gps',
      fetchedAt: 1_700_000_000_000,
      hours: [],
    })
    expect(f.source).toBe('gps')
  })

  it('rejects an invalid source', () => {
    expect(() =>
      WeatherForecast.parse({
        location: 'x', lng: 1, lat: 2, source: 'wifi', fetchedAt: 1, hours: [],
      }),
    ).toThrow()
  })

  it('rejects more than 24 hours', () => {
    const hours = Array.from({ length: 25 }, (_, i) => ({
      time: `${i}`, tempC: 1, icon: '100', text: 'x', precipMm: 0, pop: 0,
      humidity: 0, windScale: '0', windDir: 'N', pressure: 1000, feelsLikeC: 1,
    }))
    expect(() =>
      WeatherForecast.parse({ location: 'x', lng: 1, lat: 2, source: 'gps', fetchedAt: 1, hours }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/protocol exec vitest run src/types/weather.test.ts`
Expected: FAIL — `Failed to resolve import "./weather"`.

- [ ] **Step 3: Create the schema module**

Create `packages/protocol/src/types/weather.ts`:

```ts
import { z } from 'zod'

// QWeather (和风天气) config. The private key is the Ed25519 PEM content as a
// string (not a file path) so it travels through safeStorage like other module
// secrets and never touches disk in cleartext.
export const WeatherConfig = z.object({
  host: z.string().url().default('https://devapi.qweather.com'),
  projectId: z.string().default(''), // JWT sub
  credentialId: z.string().default(''), // JWT kid
  privateKeyPem: z.string().default(''),
})
export type WeatherConfig = z.infer<typeof WeatherConfig>

export function defaultWeatherConfig(): WeatherConfig {
  return WeatherConfig.parse({})
}

// On-disk wrapper. Matches the `{ <module>: <config> }` shape used by
// web-search/gmail so the store layer is identical.
export const WeatherConfigOnDisk = z.object({ weather: WeatherConfig })
export type WeatherConfigOnDisk = z.infer<typeof WeatherConfigOnDisk>

export function defaultWeatherConfigOnDisk(): WeatherConfigOnDisk {
  return { weather: defaultWeatherConfig() }
}

// One normalized hour of the grid-point forecast. Timestamps are already
// converted to the user's local timezone by the normalizer, so the renderer
// does no timezone math. `pop` is not guaranteed by the grid-hourly endpoint
// and defaults to 0 when the source omits it.
export const WeatherHour = z.object({
  time: z.string(),
  tempC: z.number(),
  icon: z.string(),
  text: z.string(),
  precipMm: z.number(),
  pop: z.number(),
  humidity: z.number(),
  windScale: z.string(),
  windDir: z.string(),
  pressure: z.number(),
  feelsLikeC: z.number(),
})
export type WeatherHour = z.infer<typeof WeatherHour>

// Forecast view-model crossing the IPC boundary. This is NEVER the raw QWeather
// payload — the main process normalizes first, insulating the renderer from
// upstream field renames. `source` tells the UI which locator won (gps/ip).
export const WeatherForecast = z.object({
  location: z.string(),
  lng: z.number(),
  lat: z.number(),
  source: z.enum(['gps', 'ip']),
  fetchedAt: z.number(),
  hours: z.array(WeatherHour).max(24),
})
export type WeatherForecast = z.infer<typeof WeatherForecast>
```

- [ ] **Step 4: Re-export from the protocol barrel**

In `packages/protocol/src/types/index.ts`, add to the existing weather-related exports (or at the end of the file, matching alphabetical/grouped order used there):

```ts
export * from './weather'
```

If that file uses named re-exports instead of a wildcard, append explicit names:

```ts
export {
  WeatherConfig,
  WeatherConfigOnDisk,
  WeatherForecast,
  WeatherHour,
  defaultWeatherConfig,
  defaultWeatherConfigOnDisk,
} from './weather'
```

(Inspect the file first and follow whichever style the other modules use — AGENTS.md §3.)

- [ ] **Step 5: Add the bridge types to `ui.ts`**

In `packages/protocol/src/types/ui.ts`, find the `WebSearchBridge`/`WebSearchSetResult` definitions (around lines 282–294) and add the weather equivalents right after them:

```ts
export type WeatherSetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type WeatherForecastResult =
  | { ok: true; forecast: WeatherForecast }
  | { ok: false; code: 'not_configured' | 'locate_failed' | 'fetch_failed'; message: string }

export type WeatherBridge = {
  getConfig(): Promise<WeatherConfig>
  setConfig(c: WeatherConfig): Promise<WeatherSetResult>
  /** lng/lat null → IP fallback in main. */
  getForecast(lng: number | null, lat: number | null): Promise<WeatherForecastResult>
  /** Pushed from main whenever a fresh forecast is fetched. */
  onForecast(cb: (f: WeatherForecast) => void): () => void
  onConfigChanged(cb: (c: WeatherConfig) => void): () => void
}
```

Then find the `SwarmBridge` type (around line 410 where `webSearch: WebSearchBridge` lives) and add a sibling field:

```ts
  weather: WeatherBridge
```

Make sure `WeatherForecast` and `WeatherConfig` are imported at the top of `ui.ts` from `./weather` (or resolve via the barrel — match how `WebSearchConfigView` is imported).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @swarm/protocol exec vitest run src/types/weather.test.ts`
Expected: PASS (all 8 assertions).

- [ ] **Step 7: Typecheck the workspace**

Run: `pnpm --filter @swarm/protocol run typecheck` (if it has its own script) else `pnpm typecheck`
Expected: PASS with no errors. If `ui.ts` references fail, fix the imports.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/types/weather.ts packages/protocol/src/types/weather.test.ts packages/protocol/src/types/index.ts packages/protocol/src/types/ui.ts
git commit -m "feat(weather): protocol schemas + bridge types

WeatherConfig/OnDisk (safeStorage wrapper), WeatherHour/Forecast view-model,
WeatherBridge + SwarmBridge.weather field. Pure zod — no platform imports."
```

---

## Task 2: Encrypted store (clone of web-search/store.ts)

**Files:**
- Create: `apps/desktop/src/main/weather/store.ts`
- Modify: `apps/desktop/src/main/constants.ts` (add `paths.weather`)
- Test: `apps/desktop/src/main/weather/store.test.ts`

**Interfaces:**
- Consumes: `WeatherConfigOnDisk`, `defaultWeatherConfigOnDisk` from Task 1.
- Produces: `Store` with `load() / loadOrRecover() / save(state)`, consumed by the service (Task 5).

- [ ] **Step 1: Add the `paths.weather` entry**

In `apps/desktop/src/main/constants.ts`, find the `paths` object (where `webSearch: () => join(app.getPath('userData'), 'web-search.enc')` lives at line 44) and add a sibling:

```ts
  weather: () => join(app.getPath('userData'), 'weather.enc'),
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/weather/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// safeStorage is only available in Electron's main process; mock it with a
// reversible XOR-ish transform so tests prove the round-trip without crypto.
const mockSafeStorage = {
  encryptString(s: string): Buffer {
    return Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)
  },
  decryptString(b: Buffer): string {
    return Buffer.from(b).map((byte) => byte ^ 0x5a).toString('utf8')
  },
  isEncryptionAvailable(): boolean {
    return true
  },
}

describe('weather store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weather-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads defaults when the file is missing', async () => {
    vi.mock('electron', () => ({ safeStorage: mockSafeStorage }))
    const { createStore } = await import('./store')
    const store = createStore({ filePath: join(dir, 'weather.enc') })
    const r = await store.loadOrRecover()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.state.weather.host).toBe('https://devapi.qweather.com')
  })

  it('round-trips a saved config through load()', async () => {
    vi.mock('electron', () => ({ safeStorage: mockSafeStorage }))
    const { createStore } = await import('./store')
    const { defaultWeatherConfigOnDisk } = await import('@swarm/protocol')
    const store = createStore({ filePath: join(dir, 'weather.enc') })
    const state = {
      weather: { ...defaultWeatherConfigOnDisk().weather, projectId: 'p1', credentialId: 'c1' },
    }
    await store.save(state)
    const loaded = await store.load()
    expect(loaded.weather.projectId).toBe('p1')
  })

  it('reports decrypt_failed on garbage bytes', async () => {
    vi.mock('electron', () => ({ safeStorage: mockSafeStorage }))
    const { createStore } = await import('./store')
    const { writeFile } = await import('node:fs/promises')
    const fp = join(dir, 'weather.enc')
    await writeFile(fp, Buffer.from([0x00, 0x01, 0x02]))
    const store = createStore({ filePath: fp })
    const r = await store.loadOrRecover()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('decrypt_failed')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/store.test.ts`
Expected: FAIL — cannot find module `./store`.

- [ ] **Step 4: Create the store**

Create `apps/desktop/src/main/weather/store.ts` (clone of `apps/desktop/src/main/web-search/store.ts`, swapped to weather types):

```ts
// Encrypted on-disk QWeather config store. Reads/writes a single file via
// Electron safeStorage (Keychain-backed on macOS). Saves are atomic (write tmp
// -> rename) and validated against the Zod schema before encryption so we never
// persist garbage. Pure module: no logging, no globals — callers inject filePath.
import { existsSync, promises as fs } from 'node:fs'
import { defaultWeatherConfigOnDisk, WeatherConfigOnDisk } from '@swarm/protocol'
import { safeStorage } from 'electron'

export type LoadResult =
  | { ok: true; state: WeatherConfigOnDisk }
  | { ok: false; reason: 'decrypt_failed' | 'schema_invalid' }

export type Store = {
  load(): Promise<WeatherConfigOnDisk> // forgiving — returns defaults on missing/failure
  loadOrRecover(): Promise<LoadResult> // strict — reports failure reason
  save(state: WeatherConfigOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const loadOrRecover: Store['loadOrRecover'] = async () => {
    if (!existsSync(filePath)) return { ok: true, state: defaultWeatherConfigOnDisk() }
    const buf = await fs.readFile(filePath)
    let json: string
    try {
      json = safeStorage.decryptString(buf)
    } catch {
      return { ok: false, reason: 'decrypt_failed' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false; reason: 'schema_invalid' }
    }
    const checked = WeatherConfigOnDisk.safeParse(parsed)
    if (!checked.success) return { ok: false, reason: 'schema_invalid' }
    return { ok: true, state: checked.data }
  }

  const load: Store['load'] = async () => {
    const r = await loadOrRecover()
    return r.ok ? r.state : defaultWeatherConfigOnDisk()
  }

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()

  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      // Validate before encrypting so we never persist garbage.
      WeatherConfigOnDisk.parse(state)
      const ciphertext = safeStorage.encryptString(JSON.stringify(state))
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, ciphertext)
      await fs.rename(tmp, filePath)
    })
    // Keep the queue alive even if one save rejects.
    saveQueue = next.catch(() => undefined)
    return next
  }

  return { load, loadOrRecover, save }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/store.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/weather/store.ts apps/desktop/src/main/weather/store.test.ts apps/desktop/src/main/constants.ts
git commit -m "feat(weather): encrypted weather.enc store via safeStorage

Clone of web-search/store.ts. Atomic write tmp->rename, schema-validated
before encrypt, loadOrRecover reports decrypt_failed/schema_invalid.
paths.weather() added to constants."
```

---

## Task 3: JWT signer (`jose`, EdDSA/Ed25519)

**Files:**
- Modify: `apps/desktop/package.json` (+ `jose`)
- Create: `apps/desktop/src/main/weather/jwt.ts`
- Test: `apps/desktop/src/main/weather/jwt.test.ts`

**Interfaces:**
- Consumes: `WeatherConfig` (needs `projectId`, `credentialId`, `privateKeyPem`).
- Produces: `signQWeatherJwt(cfg: WeatherConfig): Promise<string>` — consumed by `qweather.ts` (Task 4).

- [ ] **Step 1: Install jose**

Run: `pnpm --filter @swarm/desktop add jose@^5.9.6`
Expected: `jose` added to `apps/desktop/package.json` `dependencies` and the lockfile updated.

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/weather/jwt.test.ts`:

```ts
import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'

import type { WeatherConfig } from '@swarm/protocol'

import { signQWeatherJwt } from './jwt'

// Generate a real Ed25519 pair so the test verifies against jose's own verifier.
function ed25519Pem(): { privateKeyPem: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = createPublicKey(privateKey)
  // Export PKCS8 PEM for the signer (matches what users paste from openssl).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const privateKeyPem = (privateKey as any).export({ format: 'pem', type: 'pkcs8' }) as string
  return { privateKeyPem, publicKey }
}

describe('signQWeatherJwt', () => {
  it('produces a verifiable EdDSA JWT with kid + sub claims', async () => {
    const { privateKeyPem, publicKey } = ed25519Pem()
    const cfg: WeatherConfig = {
      host: 'https://devapi.qweather.com',
      projectId: 'proj_abc',
      credentialId: 'cred_xyz',
      privateKeyPem,
    }

    const token = await signQWeatherJwt(cfg)
    expect(typeof token).toBe('string')
    expect(token.split('.').length).toBe(3) // header.payload.signature

    // jose's own verifier must accept it, proving alg/kid/sub are well-formed.
    const spki = publicKey.export({ format: 'pem', type: 'spki' })
    const key = await (await import('jose')).importSPKI(spki, 'EdDSA')
    const { payload, protectedHeader } = await jwtVerify(token, key)
    expect(payload.sub).toBe('proj_abc')
    expect(protectedHeader.alg).toBe('EdDSA')
    expect(protectedHeader.kid).toBe('cred_xyz')
  })

  it('sets an expiry no further than 5 minutes out', async () => {
    const { privateKeyPem, publicKey } = ed25519Pem()
    const cfg: WeatherConfig = {
      host: 'x', projectId: 'p', credentialId: 'c', privateKeyPem,
    }
    const token = await signQWeatherJwt(cfg)
    const spki = publicKey.export({ format: 'pem', type: 'spki' })
    const key = await (await import('jose')).importSPKI(spki, 'EdDSA')
    const { payload } = await jwtVerify(token, key)
    const nowSec = Math.floor(Date.now() / 1000)
    expect(payload.exp ?? 0).toBeGreaterThan(nowSec)
    expect(payload.exp ?? 0).toBeLessThanOrEqual(nowSec + 300)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/jwt.test.ts`
Expected: FAIL — cannot find module `./jwt`.

- [ ] **Step 4: Implement the signer**

Create `apps/desktop/src/main/weather/jwt.ts`:

```ts
// QWeather JWT signer. QWeather authenticates requests with an EdDSA
// (Ed25519)-signed JWT: header.kid = credentialId, payload.sub = projectId,
// short-lived exp. Built with `jose`, which is the IETF reference impl and
// handles base64url padding + Ed25519 JWK import correctly (hand-rolling JWT
// signing is error-prone; the spec records jose as an accepted dependency).
import { createPrivateKey } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'

import type { WeatherConfig } from '@swarm/protocol'

export async function signQWeatherJwt(cfg: WeatherConfig): Promise<string> {
  const keyObj = createPrivateKey({ key: cfg.privateKeyPem, format: 'pem' })
  const jwk = await exportJWK(keyObj) // jose needs a JWK for Ed25519 keys
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: cfg.credentialId })
    .setSubject(cfg.projectId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(jwk)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/jwt.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/main/weather/jwt.ts apps/desktop/src/main/weather/jwt.test.ts
git commit -m "feat(weather): EdDSA/Ed25519 JWT signer via jose

signQWeatherJwt(cfg) -> header{alg:EdDSA,kid:credentialId},
payload{sub:projectId,iat,exp:5m}. Verified with jose importSPKI+jwtVerify."
```

---

## Task 4: QWeather fetch + normalizer (pure)

**Files:**
- Create: `apps/desktop/src/main/weather/qweather.ts`
- Test: `apps/desktop/src/main/weather/qweather.test.ts`

**Interfaces:**
- Consumes: `signQWeatherJwt` (Task 3), `WeatherConfig`, `WeatherForecast`, `WeatherHour` (Task 1).
- Produces: `fetchGridHourly({config,lng,lat,source,locationLabel})` + pure `normalizeHourly(raw)` — consumed by the service (Task 5).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/weather/qweather.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { normalizeHourly } from './qweather'

// A representative QWeather /v7/grid-forecast/24h `hourly` entry. Field names
// mirror the upstream payload (fxTime, temp, icon, text, windScale, windDir,
// pop, precip, humidity, pressure, feelsLike).
const sampleHour = {
  fxTime: '2026-07-06T06:00+00:00', // UTC — normalizer must convert to local tz
  temp: '24',
  icon: '100',
  text: '晴',
  windScale: '3',
  windDir: '东北',
  pop: '10',
  precip: '0.0',
  humidity: '35',
  pressure: '1013',
  feelsLike: '22',
}

describe('normalizeHourly', () => {
  it('maps a raw hour to a WeatherHour, converting fxTime to local ISO', () => {
    const [h] = normalizeHourly([sampleHour])
    expect(h.tempC).toBe(24)
    expect(h.icon).toBe('100')
    expect(h.text).toBe('晴')
    expect(h.pop).toBe(10)
    expect(h.precipMm).toBe(0)
    expect(h.humidity).toBe(35)
    expect(h.windScale).toBe('3')
    expect(h.windDir).toBe('东北')
    expect(h.pressure).toBe(1013)
    expect(h.feelsLikeC).toBe(22)
    // time is an ISO string with a timezone offset (not UTC Z).
    expect(h.time).toContain('T')
    expect(h.time).not.toContain('Z')
  })

  it('defaults pop to 0 when the source omits it', () => {
    const { pop: _drop, ...withoutPop } = sampleHour
    const [h] = normalizeHourly([withoutPop])
    expect(h.pop).toBe(0)
  })

  it('treats an empty pop string as 0', () => {
    const [h] = normalizeHourly([{ ...sampleHour, pop: '' }])
    expect(h.pop).toBe(0)
  })

  it('skips entries lacking a fxTime', () => {
    const out = normalizeHourly([{ ...sampleHour, fxTime: '' }, sampleHour])
    expect(out.length).toBe(1)
  })

  it('returns [] for an empty input', () => {
    expect(normalizeHourly([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/qweather.test.ts`
Expected: FAIL — cannot find module `./qweather`.

- [ ] **Step 3: Implement the normalizer + fetcher**

Create `apps/desktop/src/main/weather/qweather.ts`:

```ts
// QWeather grid-hourly forecast client + normalizer. The fetcher signs a JWT
// (jwt.ts) and GETs /v7/grid-forecast/24h?location=lng,lat; the normalizer
// converts the raw `hourly` payload into the WeatherHour view-model, turning
// UTC fxTime into the user's local timezone and defaulting pop->0 when absent
// (the grid-hourly endpoint does not guarantee pop).
import type { WeatherConfig, WeatherForecast, WeatherHour } from '@swarm/protocol'

import { signQWeatherJwt } from './jwt'

// Raw shape of one entry in a QWeather /v7/grid-forecast/24h `hourly` array.
// Kept loose (string fields) because QWeather returns everything as strings.
type RawHour = {
  fxTime?: string
  temp?: string
  icon?: string
  text?: string
  windScale?: string
  windDir?: string
  pop?: string
  precip?: string
  humidity?: string
  pressure?: string
  feelsLike?: string
}

const num = (v: string | undefined, fallback = 0): number => {
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Convert a raw QWeather hourly array into WeatherHour[] (pure). */
export function normalizeHourly(raw: RawHour[]): WeatherHour[] {
  const out: WeatherHour[] = []
  for (const r of raw) {
    if (!r.fxTime) continue
    const d = new Date(r.fxTime)
    if (Number.isNaN(d.getTime())) continue
    out.push({
      time: d.toString().includes('GMT')
        ? // toISOString drops offset; format with the local offset instead.
          new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().replace('Z', formatOffset(d))
        : d.toISOString(),
      tempC: num(r.temp),
      icon: r.icon ?? '',
      text: r.text ?? '',
      precipMm: num(r.precip),
      pop: num(r.pop),
      humidity: num(r.humidity),
      windScale: r.windScale ?? '',
      windDir: r.windDir ?? '',
      pressure: num(r.pressure),
      feelsLikeC: num(r.feelsLike),
    })
  }
  return out
}

// Build a +HH:MM offset string for the renderer-friendly ISO form.
function formatOffset(d: Date): string {
  const off = -d.getTimezoneOffset() // minutes; positive east of UTC
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

type FetchOpts = {
  config: WeatherConfig
  lng: number
  lat: number
  source: 'gps' | 'ip'
  locationLabel: string
}

// GET {host}/v7/grid-forecast/24h?location=lng,lat with a Bearer JWT.
// Returns the normalized forecast; throws on non-200 HTTP or QWeather code !== "200".
export async function fetchGridHourly(opts: FetchOpts): Promise<WeatherForecast> {
  const { config, lng, lat, source, locationLabel } = opts
  const token = await signQWeatherJwt(config)
  const url = `${config.host.replace(/\/+$/, '')}/v7/grid-forecast/24h?location=${lng},${lat}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new Error(`QWeather HTTP ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { code?: string; hourly?: RawHour[] }
  if (body.code !== '200') {
    throw new Error(`QWeather code ${body.code ?? 'unknown'}`)
  }
  return {
    location: locationLabel,
    lng,
    lat,
    source,
    fetchedAt: Date.now(),
    hours: normalizeHourly(body.hourly ?? []),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/qweather.test.ts`
Expected: PASS (all 5 tests). The `fetchGridHourly` path is exercised by the service integration test (Task 5); here only the pure normalizer is unit-tested.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/weather/qweather.ts apps/desktop/src/main/weather/qweather.test.ts
git commit -m "feat(weather): grid-hourly fetch + UTC->local normalizer

fetchGridHourly() signs JWT, GETs /v7/grid-forecast/24h, throws on non-200.
normalizeHourly() (pure) maps raw strings -> WeatherHour, defaults pop=0,
skips entries lacking fxTime. fxTime converted to local-tz ISO."
```

---

## Task 5: Geo locator + reverse geocode (pure fetch)

**Files:**
- Create: `apps/desktop/src/main/weather/geo.ts`
- Test: `apps/desktop/src/main/weather/geo.test.ts`

**Interfaces:**
- Consumes: `signQWeatherJwt` (for the GeoAPI reverse geocode) + `WeatherConfig`.
- Produces: `locateByIp()` → `{lng,lat,city}`, `reverseGeocode(cfg,lng,lat)` → city string — both consumed by the service (Task 6).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/weather/geo.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WeatherConfig } from '@swarm/protocol'

import { locateByIp, reverseGeocode } from './geo'

const cfg: WeatherConfig = {
  host: 'https://devapi.qweather.com',
  projectId: 'p', credentialId: 'c', privateKeyPem: '',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstub()
})

describe('locateByIp', () => {
  it('returns lng/lat/city from ip-api.com', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ query: '1.2.3.4', lat: 39.9, lon: 116.4, city: '北京市' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const r = await locateByIp()
    expect(r).toEqual({ lng: 116.4, lat: 39.9, city: '北京市' })
  })

  it('throws on non-200', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    await expect(locateByIp()).rejects.toThrow(/ip-api/)
  })

  it('throws on missing lat/lon', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ query: '1.2.3.4' }), { status: 200 }),
    )
    await expect(locateByIp()).rejects.toThrow()
  })
})

describe('reverseGeocode', () => {
  it('returns the first QWeather GeoAPI match name', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({ code: '200', location: [{ name: '北京市', id: '101010100' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const name = await reverseGeocode(cfg, 116.4, 39.9)
    expect(name).toBe('北京市')
  })

  it('throws on QWeather code !== 200', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ code: '404' }), { status: 200 }),
    )
    await expect(reverseGeocode(cfg, 1, 2)).rejects.toThrow(/404/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/geo.test.ts`
Expected: FAIL — cannot find module `./geo`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/weather/geo.ts`:

```ts
// Geolocation helpers. locateByIp() is the renderer-failure fallback (main
// process fetch, so HTTP is fine); reverseGeocode() turns GPS coords into a
// Chinese city name via QWeather's own GeoAPI so the card label matches the
// card language. Both throw on failure; the service layer logs + maps the error.
import type { WeatherConfig } from '@swarm/protocol'

import { signQWeatherJwt } from './jwt'

type IpApiResult = { query: string; lat?: number; lon?: number; city?: string }

// http (not https) is fine here: this runs in the Electron main process (not a
// browser), so mixed-content rules don't apply. ip-api.com free tier is HTTP-only.
const IP_API = 'http://ip-api.com/json/?fields=query,lat,lon,city'

export async function locateByIp(): Promise<{ lng: number; lat: number; city: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5_000)
  try {
    const res = await fetch(IP_API, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`ip-api HTTP ${res.status}`)
    const body = (await res.json()) as IpApiResult
    if (body.lat == null || body.lon == null) {
      throw new Error('ip-api returned no coordinates')
    }
    return { lng: body.lon, lat: body.lat, city: body.city || `${body.lng ?? ''},${body.lat}` }
  } finally {
    clearTimeout(timer)
  }
}

type GeoApiResult = { code?: string; location?: { name: string }[] }

export async function reverseGeocode(
  cfg: WeatherConfig,
  lng: number,
  lat: number,
): Promise<string> {
  const token = await signQWeatherJwt(cfg)
  const url = `${cfg.host.replace(/\/+$/, '')}/geo/v2/city/lookup?location=${lng},${lat}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`QWeather GeoAPI HTTP ${res.status}`)
  const body = (await res.json()) as GeoApiResult
  if (body.code !== '200' || !body.location?.length) {
    throw new Error(`QWeather GeoAPI code ${body.code ?? 'unknown'}`)
  }
  return body.location[0].name
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/geo.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/weather/geo.ts apps/desktop/src/main/weather/geo.test.ts
git commit -m "feat(weather): ip-api fallback + QWeather GeoAPI reverse geocode

locateByIp() GETs ip-api.com/json (5s timeout via AbortController).
reverseGeocode() GETs /geo/v2/city/lookup with Bearer JWT, returns first
match name. Both throw on failure; service layer logs + maps."
```

---

## Task 6: Service (config + cached forecast)

**Files:**
- Create: `apps/desktop/src/main/weather/service.ts`
- Test: `apps/desktop/src/main/weather/service.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2), `signQWeatherJwt`/`fetchGridHourly` (Tasks 3–4), `locateByIp`/`reverseGeocode` (Task 5), protocol types (Task 1).
- Produces: `Service` with `getConfig() / setConfig(c) / getForecast(lng,lat) / onConfigChanged(cb)` — consumed by `ipc.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/weather/service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultWeatherConfigOnDisk } from '@swarm/protocol'

import type { Store } from './store'

// In-memory store; the on-disk store is covered by store.test.ts.
function memStore(initial = defaultWeatherConfigOnDisk()): Store {
  let state = initial
  return {
    async load() {
      return state
    },
    async loadOrRecover() {
      return { ok: true, state }
    },
    async save(next) {
      state = next
    },
  }
}

const validCfg = {
  weather: {
    host: 'https://devapi.qweather.com',
    projectId: 'p',
    credentialId: 'c',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMI…\n-----END PRIVATE KEY-----\n',
  },
}

describe('weather service', () => {
  beforeEach(() => {
    vi.unstub()
  })

  it('getConfig returns defaults when the store is empty', async () => {
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore() })
    expect(svc.getConfig().projectId).toBe('')
  })

  it('setConfig rejects when projectId is empty', async () => {
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore() })
    const r = await svc.setConfig({ ...defaultWeatherConfigOnDisk().weather, host: 'https://x.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid')
  })

  it('setConfig persists a valid config', async () => {
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore() })
    const r = await svc.setConfig(validCfg.weather)
    expect(r.ok).toBe(true)
    expect(svc.getConfig().projectId).toBe('p')
  })

  it('broadcasts onConfigChanged after a successful save', async () => {
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore() })
    const seen: string[] = []
    svc.onConfigChanged((c) => seen.push(c.projectId))
    await svc.setConfig(validCfg.weather)
    expect(seen).toEqual(['p'])
  })

  it('getForecast returns not_configured when projectId missing', async () => {
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore() })
    await expect(svc.getForecast(null, null)).rejects.toThrow()
  })

  it('uses cached forecast within 30 min for the same rounded coords', async () => {
    vi.mock('./qweather', () => ({
      fetchGridHourly: vi.fn().mockResolvedValue({
        location: '北京市', lng: 116.4, lat: 39.9, source: 'gps',
        fetchedAt: 1_000, hours: [],
      }),
    }))
    vi.mock('./geo', () => ({
      locateByIp: vi.fn().mockResolvedValue({ lng: 116.4, lat: 39.9, city: '北京市' }),
      reverseGeocode: vi.fn().mockResolvedValue('北京市'),
    }))
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore(validCfg as never) })
    const a = await svc.getForecast(null, null)
    const b = await svc.getForecast(null, null)
    expect(a).toBe(b) // same object reference → cache hit
    const { fetchGridHourly } = await import('./qweather')
    expect(fetchGridHourly).toHaveBeenCalledTimes(1)
  })

  it('treats a different rounded coordinate as a cache miss', async () => {
    let calls = 0
    vi.mock('./qweather', () => ({
      fetchGridHourly: vi.fn().mockImplementation(async () => {
        calls += 1
        return { location: 'x', lng: 1, lat: 2, source: 'gps', fetchedAt: calls, hours: [] }
      }),
    }))
    vi.mock('./geo', () => ({
      locateByIp: vi
        .fn()
        .mockResolvedValueOnce({ lng: 116.4, lat: 39.9, city: 'a' })
        .mockResolvedValueOnce({ lng: 121.4, lat: 31.2, city: 'b' }),
      reverseGeocode: vi.fn().mockResolvedValue('x'),
    }))
    const { createService } = await import('./service')
    const svc = await createService({ store: memStore(validCfg as never) })
    await svc.getForecast(null, null)
    await svc.getForecast(null, null)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/service.test.ts`
Expected: FAIL — cannot find module `./service`.

- [ ] **Step 3: Implement the service**

Create `apps/desktop/src/main/weather/service.ts`:

```ts
// QWeather config + forecast state machine. Single source of truth for the
// encrypted config and the 30-min in-memory forecast cache. Wraps the Store
// with input validation and a config-change broadcast; getForecast resolves
// coordinates (GPS via renderer args, else IP fallback), checks the cache, then
// calls fetchGridHourly. Every business path is logged per AGENTS.md §5.
import { createLogger } from '@shared/logger'
import type { WeatherConfig, WeatherConfigOnDisk, WeatherForecast } from '@swarm/protocol'

import { locateByIp, reverseGeocode } from './geo'
import { fetchGridHourly } from './qweather'
import type { Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'weather-service' })

export type SetResult = { ok: true } | { ok: false; code: 'invalid' | 'persist_failed'; message: string }

export type Service = {
  getConfig(): WeatherConfig
  setConfig(c: WeatherConfig): Promise<SetResult>
  /** lng/lat null → IP fallback. Throws on not-configured / fetch failure. */
  getForecast(lng: number | null, lat: number | null): Promise<WeatherForecast>
  onConfigChanged(cb: (c: WeatherConfig) => void): () => void
}

const CACHE_TTL_MS = 30 * 60 * 1000
const round = (n: number): number => Math.round(n * 100) / 100

function validateConfig(c: WeatherConfig): string | null {
  const m = (msg: string): string => msg
  try {
    new URL(c.host)
  } catch {
    return m('host must be a valid URL')
  }
  if (!c.projectId.trim()) return m('Project ID must not be empty')
  if (!c.credentialId.trim()) return m('Credential ID must not be empty')
  if (!c.privateKeyPem.trim()) return m('Private key PEM must not be empty')
  if (!c.privateKeyPem.includes('BEGIN')) return m('Private key PEM looks malformed')
  return null
}

export async function createService(opts: { store: Store }): Promise<Service> {
  const disk = await opts.store.load()
  let state: WeatherConfig = disk.weather
  const listeners = new Set<(c: WeatherConfig) => void>()

  // Single-slot cache keyed by rounded "lng,lat".
  let cache: { key: string; forecast: WeatherForecast } | null = null

  const emit = (): void => {
    for (const cb of listeners) cb(state)
  }

  const persist = async (next: WeatherConfigOnDisk): Promise<SetResult> => {
    try {
      await opts.store.save(next)
    } catch (e) {
      log.error({ msg: 'failed to persist weather config', err: e instanceof Error ? e.message : String(e) })
      return { ok: false, code: 'persist_failed', message: e instanceof Error ? e.message : String(e) }
    }
    state = next.weather
    cache = null // config changed → invalidate
    emit()
    return { ok: true }
  }

  return {
    getConfig: () => state,
    async setConfig(c) {
      const err = validateConfig(c)
      if (err) return { ok: false, code: 'invalid', message: err }
      return persist({ weather: c })
    },
    async getForecast(lng, lat) {
      const err = validateConfig(state)
      if (err) {
        log.warn({ msg: 'weather forecast requested but not configured' })
        throw new Error('not configured')
      }

      // Resolve coordinates + label.
      let coordLng: number
      let coordLat: number
      let source: 'gps' | 'ip'
      let label: string
      if (lng != null && lat != null) {
        coordLng = lng
        coordLat = lat
        source = 'gps'
        label = await reverseGeocode(state, lng, lat).catch((e) => {
          log.warn({ msg: 'reverse geocode failed; using coords as label', err: String(e) })
          return `${round(lng)},${round(lat)}`
        })
      } else {
        const ip = await locateByIp()
        coordLng = ip.lng
        coordLat = ip.lat
        source = 'ip'
        label = ip.city
      }

      const key = `${round(coordLng)},${round(coordLat)}`
      if (cache && cache.key === key && Date.now() - cache.forecast.fetchedAt < CACHE_TTL_MS) {
        log.warn({ msg: 'weather cache hit', ageMs: Date.now() - cache.forecast.fetchedAt })
        return cache.forecast
      }

      const started = Date.now()
      log.info({ msg: 'weather fetch', lng: coordLng, lat: coordLat, source })
      try {
        const forecast = await fetchGridHourly({
          config: state,
          lng: coordLng,
          lat: coordLat,
          source,
          locationLabel: label,
        })
        cache = { key, forecast }
        log.info({
          msg: 'weather fetched',
          durationMs: Date.now() - started,
          hours: forecast.hours.length,
          cached: false,
        })
        return forecast
      } catch (e) {
        log.error({
          msg: 'weather fetch failed',
          err: e instanceof Error ? e.message : String(e),
          lng: coordLng,
          lat: coordLat,
          source,
        })
        throw e
      }
    },
    onConfigChanged(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @swarm/desktop exec vitest run src/main/weather/service.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/weather/service.ts apps/desktop/src/main/weather/service.test.ts
git commit -m "feat(weather): service with config validation + 30-min forecast cache

createService({store}): getConfig/setConfig/getForecast/onConfigChanged.
getForecast resolves gps (renderer args) or ip fallback, checks rounded-coord
cache (30min TTL, invalidated on config change), logs every path per §5."
```

---

## Task 7: IPC handlers + bootstrap

**Files:**
- Create: `apps/desktop/src/main/weather/ipc.ts`
- Create: `apps/desktop/src/main/weather/index.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `Service` (Task 6).
- Produces: `weather:getConfig` / `weather:setConfig` / `weather:getForecast` IPC channels; `initWeather()` returning `{ service, dispose }`.

- [ ] **Step 1: Create the IPC wiring**

Create `apps/desktop/src/main/weather/ipc.ts`:

```ts
// Wires the weather service to Electron IPC. Exposes getConfig/setConfig/
// getForecast handlers and broadcasts fresh forecasts to all renderer windows
// (the dashboard card subscribes so it updates without polling). Config changes
// are read on demand (the hook re-queries), so no push channel is needed there.
import { createLogger } from '@shared/logger'
import type { WeatherConfig } from '@swarm/protocol'
import { BrowserWindow, ipcMain } from 'electron'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'weather-ipc' })

const FORECAST_CHANNEL = 'weather:forecastChanged'

export function wireWeatherIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args

  ipcMain.handle('weather:getConfig', () => service.getConfig())

  ipcMain.handle('weather:setConfig', (_e: Electron.IpcMainInvokeEvent, c: unknown) => {
    if (typeof c !== 'object' || c === null) {
      return { ok: false, code: 'invalid', message: 'config must be an object' }
    }
    return service.setConfig(c as WeatherConfig)
  })

  ipcMain.handle(
    'weather:getForecast',
    (_e: Electron.IpcMainInvokeEvent, lng: unknown, lat: unknown) => {
      const l = typeof lng === 'number' ? lng : null
      const la = typeof lat === 'number' ? lat : null
      return service
        .getForecast(l, la)
        .then((forecast) => {
          // Push the fresh forecast to every renderer so the dashboard card
          // updates without a re-fetch.
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send(FORECAST_CHANNEL, forecast)
          }
          return { ok: true as const, forecast }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          const code = message === 'not configured' ? 'not_configured' : 'fetch_failed'
          return { ok: false as const, code, message }
        })
    },
  )

  log.info({ msg: 'weather IPC wired' })

  return {
    dispose(): void {
      ipcMain.removeHandler('weather:getConfig')
      ipcMain.removeHandler('weather:setConfig')
      ipcMain.removeHandler('weather:getForecast')
    },
  }
}
```

- [ ] **Step 2: Create the bootstrap entry**

Create `apps/desktop/src/main/weather/index.ts`:

```ts
// Entry point for the QWeather subsystem. Wires the encrypted store, the
// in-memory service, and the Electron IPC layer. Runs after app.whenReady()
// (safeStorage is available by then — providers/gmail already rely on it).
import { createLogger } from '@shared/logger'

import { paths } from '../constants'
import { wireWeatherIpc } from './ipc'
import { createService, type Service } from './service'
import { createStore } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'weather' })

export type WeatherHandle = {
  service: Service
  dispose(): void
}

export async function initWeather(): Promise<WeatherHandle> {
  const filePath = paths.weather()
  const store = createStore({ filePath })
  const loaded = await store.loadOrRecover()
  if (!loaded.ok) {
    log.warn({ msg: 'weather config load failed at boot, using defaults', reason: loaded.reason })
  }

  const service = await createService({ store })
  const { dispose } = wireWeatherIpc({ service })

  return { service, dispose }
}

export type { Service } from './service'
```

- [ ] **Step 3: Wire initWeather into main/index.ts**

In `apps/desktop/src/main/index.ts`:

(a) Add the import alongside `initWebSearch` (around line 24):
```ts
import { initWeather } from './weather'
```

(b) After `const calendar = await initCalendar()` + its log line (around line 73), add:
```ts
  const weather = await initWeather()
  log.info({ msg: 'weather initialised' })
```

(c) In the `app.on('before-quit', ...)` handler (around line 84–92), add `weather.dispose()` next to the other dispose calls:
```ts
    calendar.dispose()
    weather.dispose()
```

(Do NOT touch `wireSwarmIpc` — weather does not inject into the Agent Service process, unlike web-search/providers.)

- [ ] **Step 4: Typecheck the main process**

Run: `pnpm --filter @swarm/desktop run typecheck:node`
Expected: PASS. If `initWeather`/`weather.dispose` errors appear, re-check the placement.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/weather/ipc.ts apps/desktop/src/main/weather/index.ts apps/desktop/src/main/index.ts
git commit -m "feat(weather): IPC handlers + initWeather bootstrap

wireWeatherIpc exposes weather:getConfig/setConfig/getForecast and pushes
fresh forecasts to all windows. initWeather() wires store+service+ipc.
main/index.ts bootstraps it and disposes on quit. No swarm-ipc change —
weather does not inject into the Agent Service."
```

---

## Task 8: Preload bridge

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: `WeatherBridge` (Task 1) on the `swarm` object.
- Produces: `window.swarm.weather.*` consumed by the renderer hook (Task 9).

- [ ] **Step 1: Add the forecast channel constant**

In `apps/desktop/src/preload/index.ts`, near the existing `WEB_SEARCH_STATE_CHANNEL` constant (around line 76), add:

```ts
const WEATHER_FORECAST_CHANNEL = 'weather:forecastChanged'
```

- [ ] **Step 2: Build the weather bridge object**

Right after the `webSearch` bridge object definition (which ends around line 166), add:

```ts
const weather: WeatherBridge = {
  getConfig: () => ipcRenderer.invoke('weather:getConfig') as Promise<WeatherConfig>,
  setConfig: (c) => ipcRenderer.invoke('weather:setConfig', c) as Promise<WeatherSetResult>,
  getForecast: (lng, lat) =>
    ipcRenderer.invoke('weather:getForecast', lng, lat) as Promise<WeatherForecastResult>,
  onForecast: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: WeatherForecast): void => cb(payload)
    ipcRenderer.on(WEATHER_FORECAST_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(WEATHER_FORECAST_CHANNEL, listener)
    }
  },
  onConfigChanged: () => () => {},
}
```

Notes:
- `onConfigChanged` is a no-op for now because the renderer hook re-queries config on demand (the Settings view reloads after save). If a future task needs push, wire it — but YAGNI for this feature.
- Add the type imports at the top of the file alongside the existing `WebSearchBridge`/`WebSearchConfigView` imports:
  ```ts
  import type {
    WeatherBridge,
    WeatherConfig,
    WeatherForecastResult,
    WeatherSetResult,
  } from '@swarm/protocol'
  ```
  (And `WeatherForecast` if not already pulled in via `WeatherForecastResult`.)

- [ ] **Step 3: Mount it on the `swarm` bridge**

Find where `webSearch,` is listed inside the `swarm: SwarmBridge` object (around line 379) and add right after it:

```ts
    weather,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:web` && `pnpm --filter @swarm/desktop run typecheck:node`
Expected: PASS. `window.swarm.weather` is now typed everywhere.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(weather): expose window.swarm.weather via contextBridge

getConfig/setConfig/getForecast invoke the main handlers; onForecast
subscribes to weather:forecastChanged. onConfigChanged left a no-op (the
hook re-queries on demand — YAGNI)."
```

---

## Task 9: Renderer hook (`use-weather`)

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-weather.ts`

**Interfaces:**
- Consumes: `window.swarm.weather` (Task 8), protocol types (Task 1).
- Produces: `useWeather()` returning `{ config, forecast, status, error, refresh, clear }` — consumed by `weather-view.tsx` (Task 10) and `weather-card.tsx` (Task 11).

- [ ] **Step 1: Implement the hook**

Create `apps/desktop/src/renderer/src/hooks/use-weather.ts`:

```ts
// Subscribes to the QWeather config + forecast from main. Mirrors use-web-search,
// extended with forecast state (status machine: idle/locating/fetching/ready/error)
// and a refresh() that runs geolocation in the renderer before asking main for data.
import { useCallback, useEffect, useState } from 'react'
import type { WeatherConfig, WeatherForecast } from '@swarm/protocol'

type Status = 'idle' | 'locating' | 'fetching' | 'ready' | 'error'

const DEFAULT_CONFIG: WeatherConfig = {
  host: 'https://devapi.qweather.com',
  projectId: '',
  credentialId: '',
  privateKeyPem: '',
}

export type UseWeather = {
  config: WeatherConfig
  forecast: WeatherForecast | null
  status: Status
  error: string | null
  /** Run geolocation (gps -> ip fallback) then fetch the forecast. */
  refresh(): Promise<void>
  /** Forget the current forecast (e.g. when leaving the dashboard). */
  clear(): void
}

export function useWeather(): UseWeather {
  const [config, setConfig] = useState<WeatherConfig>(DEFAULT_CONFIG)
  const [forecast, setForecast] = useState<WeatherForecast | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  // Load config once + subscribe to pushed forecasts.
  useEffect(() => {
    let cancelled = false
    void window.swarm.weather.getConfig().then((c) => {
      if (!cancelled) setConfig(c)
    })
    const offForecast = window.swarm.weather.onForecast((f) => {
      if (!cancelled) {
        setForecast(f)
        setStatus('ready')
        setError(null)
      }
    })
    return () => {
      cancelled = true
      offForecast()
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setStatus('locating')
    setError(null)

    // Renderer-side geolocation (OS permission prompt). On any failure, fall
    // through to IP fallback by passing null coords to main.
    let lng: number | null = null
    let lat: number | null = null
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            timeout: 8_000,
            maximumAge: 5 * 60_000,
          })
        })
        lng = pos.coords.longitude
        lat = pos.coords.latitude
      } catch {
        // Silent: fall back to IP. The card shows the resulting source badge.
      }
    }

    setStatus('fetching')
    const r = await window.swarm.weather.getForecast(lng, lat)
    if (r.ok) {
      // The push handler will also fire; setting here is harmless and covers
      // the case where the push ordering is delayed.
      setForecast(r.forecast)
      setStatus('ready')
    } else {
      setError(r.message)
      setStatus('error')
    }
  }, [])

  const clear = useCallback((): void => {
    setForecast(null)
    setStatus('idle')
    setError(null)
  }, [])

  return { config, forecast, status, error, refresh, clear }
}
```

- [ ] **Step 2: Typecheck the renderer**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-weather.ts
git commit -m "feat(weather): useWeather hook (config + forecast + status)

Mirrors use-web-search; adds forecast state + refresh() that runs renderer
geolocation (8s timeout, gps->ip fallback) then calls main getForecast.
Subscribes to onForecast so the card updates on pushed refreshes."
```

---

## Task 10: Settings view

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/weather-view.tsx`

**Interfaces:**
- Consumes: `useWeather` (Task 9), `Section` / `SettingsHeader` from `settings-primitives`, `Input`/`Button`/`Textarea` from `@swarm/ui`.
- Produces: `WeatherView` component used by `settings-dialog.tsx` (Task 12).

- [ ] **Step 1: Implement the view**

Create `apps/desktop/src/renderer/src/components/views/weather-view.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { WeatherConfig } from '@swarm/protocol'
import { Button, Input } from '@swarm/ui'

import { useWeather } from '@/hooks/use-weather'
import { Section, SettingsHeader } from './settings-primitives'

export function WeatherView(): React.JSX.Element {
  const { config } = useWeather()
  const [draft, setDraft] = useState<WeatherConfig>(config)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Keep the draft in sync when the server value loads/changes.
  useEffect(() => {
    setDraft(config)
  }, [config])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.swarm.weather.setConfig(draft)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Weather"
        description={
          <>
            QWeather (和风天气) grid-point hourly forecast for the dashboard card. Credentials are encrypted
            at rest via the system Keychain. Generate an Ed25519 key pair in the QWeather console, register the
            public key as a credential, then paste the Project ID, Credential ID, and the private key PEM below.
          </>
        }
      />

      <Section label="Host">
        <Input
          onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          placeholder="https://devapi.qweather.com"
          value={draft.host}
        />
        <p className="text-muted-foreground text-xs">
          Public dev host: <code>https://devapi.qweather.com</code>. Commercial: <code>https://api.qweather.com</code>.
        </p>
      </Section>

      <hr className="border-border" />

      <Section label="Project ID">
        <Input
          onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
          placeholder="e.g. 1234567890abcdef"
          value={draft.projectId}
        />
      </Section>

      <Section label="Credential ID">
        <Input
          onChange={(e) => setDraft({ ...draft, credentialId: e.target.value })}
          placeholder="e.g. 9876543210fedcba"
          value={draft.credentialId}
        />
      </Section>

      <Section label="Private Key (Ed25519 PEM)">
        <textarea
          className="border-border bg-background font-mono text-xs w-full rounded-md border px-3 py-2"
          onChange={(e) => setDraft({ ...draft, privateKeyPem: e.target.value })}
          placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
          rows={6}
          value={draft.privateKeyPem}
        />
        <p className="text-muted-foreground text-xs">
          Paste the contents of your <code>ed25519-private.pem</code>. Stored encrypted; never leaves the main process.
        </p>
      </Section>

      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        {error && <span className="text-destructive text-xs">{error}</span>}
        {!error && config.projectId && <span className="text-muted-foreground text-xs">✓ configured</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: PASS. If `Textarea` is wanted instead of raw `<textarea>`, check `@swarm/ui` exports first; if absent, keep the raw element (matches "no speculative deps").

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/weather-view.tsx
git commit -m "feat(weather): Settings view for host/projectId/credentialId/pem

Four-field form cloning web-search-view structure. Draft synced to server
config; Save calls weather:setConfig, surfaces invalid/persist_failed errors.
Helper text points users at their ed25519-private.pem."
```

---

## Task 11: Dashboard WeatherCard

**Files:**
- Create: `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx`

**Interfaces:**
- Consumes: `useWeather` (Task 9), `WeatherForecast`/`WeatherHour` (Task 1), `recharts`, `useSettingsDialog` (to open Settings).
- Produces: `WeatherCard` component mounted by `home-dashboard.tsx` (Task 12).

- [ ] **Step 1: Implement the card**

Create `apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx`:

```tsx
// Dashboard weather widget. Uses useWeather for config + forecast + status,
// runs renderer geolocation on mount + on a manual refresh, and renders current
// conditions plus temperature / precipitation-probability trend charts (recharts).
// When unconfigured, shows a guidance card that opens Settings → weather.
import { useEffect } from 'react'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { useWeather } from '@/hooks/use-weather'
import { useSettingsDialog } from '@/stores/settings-dialog'

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
```

Note: the `<Button>` import from `@swarm/ui` is needed — add it to the import line at the top:
```tsx
import { Button } from '@swarm/ui'
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @swarm/desktop run typecheck:web`
Expected: PASS. If recharts v3 exports differ (e.g. `ResponsiveContainer` path), adjust the import to match the installed version — the existing project already uses recharts elsewhere, so follow whatever pattern those files use (search `from 'recharts'` in the renderer).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/dashboard/weather-card.tsx
git commit -m "feat(weather): dashboard WeatherCard with recharts trends

Renders idle guidance / skeleton / error / ready states. On mount + manual
refresh runs geolocation via the hook. Current conditions from hours[0];
recharts LineChart (temp) + AreaChart (pop%) themed with CSS variables.
Auto-refreshes on visibilitychange when cache >30min."
```

---

## Task 12: Mount into settings + dashboard

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/settings-dialog.ts`
- Modify: `apps/desktop/src/renderer/src/components/settings-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx`

**Interfaces:**
- Consumes: `WeatherView` (Task 10), `WeatherCard` (Task 11), `useSettingsDialog`.

- [ ] **Step 1: Add `'weather'` to the settings section union + list**

In `apps/desktop/src/renderer/src/stores/settings-dialog.ts`:

(a) Add `'weather'` to the `SettingsSection` union (after `'web-search'`, before `'gmail'`):
```ts
export type SettingsSection =
  | 'general'
  | 'providers'
  | 'mcp'
  | 'web-search'
  | 'weather'
  | 'gmail'
  // …unchanged…
```

(b) Add `'weather'` to the `SECTIONS` array in the same position:
```ts
const SECTIONS: SettingsSection[] = [
  'general',
  'providers',
  'mcp',
  'web-search',
  'weather',
  'gmail',
  // …unchanged…
]
```

- [ ] **Step 2: Register the WeatherView + icon in settings-dialog.tsx**

In `apps/desktop/src/renderer/src/components/settings-dialog.tsx`:

(a) Add the import for the icon (e.g. `CloudSun` from `lucide-react`) alongside the existing `Search`/`Mail`/`Calendar` imports (around line 9). If `CloudSun` isn't exported by the installed lucide version, use `Cloud` instead.
```tsx
import { CloudSun } from 'lucide-react'
```

(b) Add the view import near `WebSearchView` (line 29):
```tsx
import { WeatherView } from '@/components/views/weather-view'
```

(c) Add a row to the `SECTIONS` array (after the `web-search` row, line 37):
```tsx
  { key: 'weather', label: 'Weather', icon: CloudSun, View: WeatherView },
```

- [ ] **Step 3: Mount WeatherCard on the dashboard**

In `apps/desktop/src/renderer/src/components/views/home-dashboard.tsx`:

(a) Add the import near the other dashboard component imports (around line 13–16):
```tsx
import { WeatherCard } from '@/components/views/dashboard/weather-card'
```

(b) Render the card. Add it as a new section between the composer section and the RunningCards, OR inside the bottom grid. The least-invasive placement that gives the card good visibility is a new section right after the composer `<section>...</section>` (before `{/* 进行中 */}`). Insert:

```tsx
        {/* 天气 */}
        <WeatherCard />
```

(Final placement is the user's visual call; this plan puts it above the running-cards wall so current weather is glanceable on entry. Do NOT restructure the surrounding grid.)

- [ ] **Step 4: Typecheck + boundary check**

Run: `pnpm --filter @swarm/desktop run typecheck:web` && `pnpm --filter @swarm/desktop run typecheck:node`
Expected: PASS.

Run: `pnpm check-boundaries`
Expected: PASS — protocol weather types are pure zod (no platform imports).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/settings-dialog.ts apps/desktop/src/renderer/src/components/settings-dialog.tsx apps/desktop/src/renderer/src/components/views/home-dashboard.tsx
git commit -m "feat(weather): mount WeatherCard + add Weather settings section

settings-dialog: 'weather' section (CloudSun icon) between web-search and
gmail. home-dashboard: render <WeatherCard/> above the running-cards wall."
```

---

## Task 13: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full repo typecheck**

Run: `pnpm typecheck`
Expected: PASS across all 6 packages. Investigate any new errors against the changed files.

- [ ] **Step 2: Full repo test suite**

Run: `pnpm test`
Expected: All weather specs pass; no pre-existing specs regress. If a pre-existing test breaks, it must trace to a weather change (e.g. the `SettingsSection` union widening) — fix the test only if our change legitimately requires it, and call it out in the commit.

- [ ] **Step 3: Boundary check**

Run: `pnpm check-boundaries`
Expected: PASS.

- [ ] **Step 4: Lint (biome)**

Run: `pnpm lint`
Expected: PASS on new files. Pre-existing lint debt elsewhere is out of scope (AGENTS.md §3) — do not fix unrelated findings; if biome reports them, note it but leave them.

- [ ] **Step 5: Manual smoke test**

Run: `pnpm --filter @swarm/desktop run dev`
Then in the app:
1. Open Settings → Weather; paste host / Project ID / Credential ID / the contents of `ed25519-private.pem`; Save → see "✓ configured".
2. Return to the dashboard; grant the macOS location prompt (or deny → IP fallback).
3. Confirm: card shows location + source badge, current temp/text/feels-like/pop/wind/pressure, and the two recharts trend charts render with hourly ticks.
4. Click ↻; confirm a refresh. Wait or change networks; confirm the ip path works when location is denied.

- [ ] **Step 6: Final commit (if any fixups)**

If Steps 1–4 surfaced fixups, commit them with clear messages. Otherwise this step is a no-op — Task 12's commit is the last code change.

---

## Out of Scope (reminders for the implementer)

- No agent tool exposure — display only.
- No disk caching of forecasts (in-memory only).
- No multi-location support; no daily/weekly forecast (grid-**hourly** only).
- The repo-root `ed25519-*.pem` files are **not** read by code; they are pasted into Settings. Leave them untracked.
- Do not touch `swarm-ipc.ts` — weather does not inject into the Agent Service.
