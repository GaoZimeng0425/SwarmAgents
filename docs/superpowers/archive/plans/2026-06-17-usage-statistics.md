# Usage Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app `/usage` dashboard (Chinese labels) showing token/cost/session/message activity, an activity heatmap, a daily-token bar trend, and a per-model donut — all derived from data already in SQLite.

**Architecture:** A new read-only RPC method `getUsageStats(rangeDays)` is threaded through the existing chain (renderer → preload → main IPC → service-client → dispatcher → session-manager → conversation-store), exactly mirroring `getSessionTasks`. The store computes every metric with SQL aggregation (`json_extract`, `date(..,'unixepoch','localtime')`); pure date helpers live in a separate, unit-tested module. The renderer adds a TanStack file-route rendering a `UsageView` that fetches the stats and composes recharts charts plus a CSS-grid heatmap.

**Tech Stack:** Electron + TypeScript, better-sqlite3, zod, TanStack Router, React, recharts 3.8 (+ shadcn `ui/chart.tsx`), date-fns, lucide-react, sonner.

## Global Constraints

- **Tests run via Electron node:** use `npm test` (never bare `npx vitest`). It is `cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`.
- **Never** run `pnpm rebuild better-sqlite3` (breaks the app ABI). If native modules misbehave, run `npm run postinstall`.
- **Logging (CLAUDE.md §5):** every new business path logs entry (`info`), outcome with `durationMs` (`info`), and every `catch` (`error`) before rethrowing. Use `createLogger(...).child({ component })` and structured first-arg objects.
- **Lint scope:** format only touched files with `npx biome check --write <file>` (a bare `pnpm check`/`format` reformats the whole repo).
- **Labels are hardcoded Chinese literals** (no i18n framework). Numbers via `Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })`.
- **Spec:** `docs/superpowers/specs/2026-06-17-usage-statistics-design.md`.

---

## File Structure

- Create `src/shared/types/usage.ts` — `UsageStats`/`ModelUsage`/`DayBucket` types + zod schema. (Task 1)
- Create `src/service/usage-stats.ts` — pure date helpers (`dayKey`, `dayKeysEndingAt`, `rangeCutoffMs`, `currentStreak`, `zeroFillDaily`). (Task 2)
- Create `src/service/usage-stats.test.ts` — unit tests for the helpers. (Task 2)
- Modify `src/service/conversation-store.ts` — add `getUsageStats(rangeDays)`. (Task 3)
- Modify `src/service/conversation-store.test.ts` — integration tests. (Task 3)
- Modify the RPC chain: `service-ipc.ts`, `session-manager.ts`, `dispatcher.ts`, `service-client.ts`, `main/ipc/swarm-ipc.ts`, `preload/index.ts`, `shared/types/ui.ts`, `renderer/src/lib/api.ts`. (Task 4)
- Modify `src/service/dispatcher.test.ts` — route test. (Task 4)
- Create `src/renderer/src/lib/usage-format.ts` + `.test.ts` — pure formatters/shade bucketing. (Task 5)
- Create `src/renderer/src/routes/usage.tsx` + `src/renderer/src/components/views/usage-view.tsx`; modify `src/renderer/src/components/app-sidebar.tsx`. (Task 5)
- Create chart subcomponents in `usage-view.tsx` (or co-located files). (Task 6)

---

## Task 1: Shared `UsageStats` types + schema

**Files:**
- Create: `src/shared/types/usage.ts`
- Test: `src/shared/types/usage.test.ts`

**Interfaces:**
- Produces:
  - `type ModelUsage = { model: string; tokens: number; pct: number }`
  - `type DayBucket = { date: string; tokens: number }`
  - `type UsageRange = 7 | 30`
  - `type UsageStats = { rangeDays: UsageRange; totals: { tokens: number; usdCents: number; sessions: number; messages: number; activeDays: number; currentStreak: number; topModel: ModelUsage | null }; daily: DayBucket[]; byModel: ModelUsage[]; heatmap: DayBucket[] }`
  - `const UsageStatsSchema` (zod) and `const HEATMAP_DAYS = 84`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/types/usage.test.ts
import { describe, expect, it } from 'vitest'
import { HEATMAP_DAYS, UsageStatsSchema } from './usage'

describe('UsageStatsSchema', () => {
  it('parses a well-formed stats object', () => {
    const ok = UsageStatsSchema.safeParse({
      rangeDays: 30,
      totals: { tokens: 100, usdCents: 5, sessions: 2, messages: 8, activeDays: 1, currentStreak: 1, topModel: { model: 'GLM-5.2', tokens: 100, pct: 100 } },
      daily: [{ date: '2026-06-17', tokens: 100 }],
      byModel: [{ model: 'GLM-5.2', tokens: 100, pct: 100 }],
      heatmap: [{ date: '2026-06-17', tokens: 100 }],
    })
    expect(ok.success).toBe(true)
  })

  it('rejects an invalid rangeDays and exposes the heatmap window', () => {
    expect(UsageStatsSchema.safeParse({ rangeDays: 99 }).success).toBe(false)
    expect(HEATMAP_DAYS).toBe(84)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types/usage.test.ts`
Expected: FAIL — cannot find module `./usage`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/types/usage.ts
import { z } from 'zod'

/** Fixed trailing window for the activity heatmap, independent of the range toggle. */
export const HEATMAP_DAYS = 84

export const ModelUsageSchema = z.object({
  model: z.string(),
  tokens: z.number().int().nonnegative(),
  pct: z.number().nonnegative(),
})
export type ModelUsage = z.infer<typeof ModelUsageSchema>

export const DayBucketSchema = z.object({
  date: z.string(), // 'YYYY-MM-DD' in local time
  tokens: z.number().int().nonnegative(),
})
export type DayBucket = z.infer<typeof DayBucketSchema>

export const UsageRangeSchema = z.union([z.literal(7), z.literal(30)])
export type UsageRange = z.infer<typeof UsageRangeSchema>

export const UsageStatsSchema = z.object({
  rangeDays: UsageRangeSchema,
  totals: z.object({
    tokens: z.number().int().nonnegative(),
    usdCents: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
    currentStreak: z.number().int().nonnegative(),
    topModel: ModelUsageSchema.nullable(),
  }),
  daily: z.array(DayBucketSchema),
  byModel: z.array(ModelUsageSchema),
  heatmap: z.array(DayBucketSchema),
})
export type UsageStats = z.infer<typeof UsageStatsSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/types/usage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/shared/types/usage.ts src/shared/types/usage.test.ts
git add src/shared/types/usage.ts src/shared/types/usage.test.ts
git commit -m "feat(usage): add UsageStats shared types + schema"
```

---

## Task 2: Pure date helpers (`usage-stats.ts`)

**Files:**
- Create: `src/service/usage-stats.ts`
- Test: `src/service/usage-stats.test.ts`

**Interfaces:**
- Consumes: `DayBucket` from `@shared/types/usage`.
- Produces:
  - `dayKey(d: Date): string` — local `yyyy-MM-dd`.
  - `dayKeysEndingAt(now: Date, count: number): string[]` — ascending, length `count`, last element is today.
  - `rangeCutoffMs(now: Date, rangeDays: number): number` — epoch-ms of the start of the day `rangeDays-1` days before `now`.
  - `currentStreak(activeKeys: Set<string>, now: Date): number` — consecutive days ending today.
  - `zeroFillDaily(rows: DayBucket[], keys: string[]): DayBucket[]` — one bucket per key (in `keys` order), tokens from `rows` or 0.

- [ ] **Step 1: Write the failing test**

```ts
// src/service/usage-stats.test.ts
import { describe, expect, it } from 'vitest'
import { currentStreak, dayKey, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'

const at = (s: string) => new Date(s) // local-time parse for 'YYYY-MM-DDTHH:mm'

describe('usage-stats helpers', () => {
  it('dayKey formats local YYYY-MM-DD', () => {
    expect(dayKey(at('2026-06-17T09:30'))).toBe('2026-06-17')
  })

  it('dayKeysEndingAt returns ascending keys ending today', () => {
    expect(dayKeysEndingAt(at('2026-06-17T10:00'), 3)).toEqual(['2026-06-15', '2026-06-16', '2026-06-17'])
  })

  it('rangeCutoffMs is start-of-day rangeDays-1 days back', () => {
    expect(rangeCutoffMs(at('2026-06-17T10:00'), 7)).toBe(at('2026-06-11T00:00').getTime())
  })

  it('currentStreak counts consecutive days ending today; gap breaks it', () => {
    const now = at('2026-06-17T10:00')
    expect(currentStreak(new Set(['2026-06-17', '2026-06-16', '2026-06-15']), now)).toBe(3)
    expect(currentStreak(new Set(['2026-06-17', '2026-06-15']), now)).toBe(1)
    expect(currentStreak(new Set(['2026-06-16', '2026-06-15']), now)).toBe(0) // today missing
    expect(currentStreak(new Set(), now)).toBe(0)
  })

  it('zeroFillDaily fills gaps and preserves key order', () => {
    const out = zeroFillDaily([{ date: '2026-06-16', tokens: 50 }], ['2026-06-15', '2026-06-16', '2026-06-17'])
    expect(out).toEqual([
      { date: '2026-06-15', tokens: 0 },
      { date: '2026-06-16', tokens: 50 },
      { date: '2026-06-17', tokens: 0 },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/service/usage-stats.test.ts`
Expected: FAIL — cannot find module `./usage-stats`.

- [ ] **Step 3: Write the implementation**

```ts
// src/service/usage-stats.ts
import type { DayBucket } from '@shared/types/usage'
import { format, startOfDay, subDays } from 'date-fns'

/** Local-time 'yyyy-MM-dd' — matches SQLite date(.., 'unixepoch', 'localtime'). */
export function dayKey(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** `count` ascending day keys, last element = the day of `now`. */
export function dayKeysEndingAt(now: Date, count: number): string[] {
  const keys: string[] = []
  for (let i = count - 1; i >= 0; i--) keys.push(dayKey(subDays(now, i)))
  return keys
}

/** Epoch-ms of the start of the day `rangeDays - 1` days before `now`. */
export function rangeCutoffMs(now: Date, rangeDays: number): number {
  return startOfDay(subDays(now, rangeDays - 1)).getTime()
}

/** Consecutive active days ending today (0 if today is not active). */
export function currentStreak(activeKeys: Set<string>, now: Date): number {
  let streak = 0
  for (let i = 0; ; i++) {
    if (!activeKeys.has(dayKey(subDays(now, i)))) break
    streak++
  }
  return streak
}

/** One bucket per key (in order); tokens from `rows` when present, else 0. */
export function zeroFillDaily(rows: DayBucket[], keys: string[]): DayBucket[] {
  const byDate = new Map(rows.map((r) => [r.date, r.tokens]))
  return keys.map((date) => ({ date, tokens: byDate.get(date) ?? 0 }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/service/usage-stats.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/service/usage-stats.ts src/service/usage-stats.test.ts
git add src/service/usage-stats.ts src/service/usage-stats.test.ts
git commit -m "feat(usage): add pure date/streak helpers"
```

---

## Task 3: Store aggregation `getUsageStats`

**Files:**
- Modify: `src/service/conversation-store.ts` (add method to `ConversationStore` type + implementation; import helpers + types)
- Modify: `src/service/conversation-store.test.ts` (integration tests)

**Interfaces:**
- Consumes: `rangeCutoffMs`, `dayKeysEndingAt`, `currentStreak`, `zeroFillDaily` from `./usage-stats`; `UsageStats`, `HEATMAP_DAYS` from `@shared/types/usage`.
- Produces: `getUsageStats(rangeDays: number): UsageStats` on the `ConversationStore` type.

Notes for the implementer:
- `tasks.used` and `tasks.budget` are JSON text; read fields with `json_extract(used, '$.tokens')` / `'$.usdCents'`.
- `task_events.event` is JSON text; filter messages with `json_extract(event, '$.kind') = 'llm.message'`.
- Convert epoch-ms columns to local date strings with `date(<col>/1000, 'unixepoch', 'localtime')`.
- `rangeDays` is clamped to `7 | 30` (default 30 for any other value) so the typed return is honoured.
- Per-model attribution joins `tasks` to `sessions` and reads `json_extract(provider_snapshot, '$.model')`.

- [ ] **Step 1: Write the failing tests**

Add to `src/service/conversation-store.test.ts` (inside the existing `describe('ConversationStore', ...)`):

```ts
  it('aggregates usage stats over the range', () => {
    const store = createConversationStore(dbPath)
    const anthropic = { id: 'anthropic' as const, model: 'claude-sonnet-4-5', apiKey: 'k' }
    const glm = { id: 'custom' as const, model: 'GLM-5.2', apiKey: 'k' }
    store.createSession('ses-a', anthropic)
    store.createSession('ses-b', glm)

    const now = Date.now()
    const day = 86_400_000
    const mkTask = (id: string, sessionId: string, tokens: number, usdCents: number, createdAt: number) => {
      store.saveTask(
        {
          id,
          parentId: null,
          agentDefId: 'default',
          goal: 'g',
          status: 'completed',
          assignedWorkerId: null,
          toolAllowlist: [],
          budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
          used: { tokens, calls: 1, wallMs: 1, usdCents },
          history: [],
          attachments: [],
          plan: [],
          result: null,
          createdAt,
          startedAt: createdAt,
          endedAt: createdAt,
        },
        sessionId
      )
    }
    mkTask('t-recent-a', 'ses-a', 1000, 12, now)
    mkTask('t-recent-b', 'ses-b', 500, 0, now - day)
    mkTask('t-old', 'ses-a', 9999, 99, now - 40 * day) // outside 30d

    store.appendTaskEvent('t-recent-a', { kind: 'llm.message', role: 'assistant', content: 'hi', ts: now })
    store.appendTaskEvent('t-recent-a', { kind: 'llm.message', role: 'user', content: 'yo', ts: now })
    store.appendTaskEvent('t-recent-a', { kind: 'reasoning', content: 'think', ts: now }) // not a message

    const stats = store.getUsageStats(30)
    expect(stats.rangeDays).toBe(30)
    expect(stats.totals.tokens).toBe(1500) // old task excluded
    expect(stats.totals.usdCents).toBe(12)
    expect(stats.totals.sessions).toBe(2)
    expect(stats.totals.messages).toBe(2)
    expect(stats.totals.activeDays).toBe(2)
    expect(stats.byModel.map((m) => m.model).sort()).toEqual(['GLM-5.2', 'claude-sonnet-4-5'])
    expect(stats.byModel.find((m) => m.model === 'claude-sonnet-4-5')?.tokens).toBe(1000)
    expect(stats.totals.topModel?.model).toBe('claude-sonnet-4-5')
    expect(stats.daily.length).toBe(30)
    expect(stats.heatmap.length).toBe(84)
    store.close()
  })

  it('returns an empty-but-shaped result with no data', () => {
    const store = createConversationStore(dbPath)
    const stats = store.getUsageStats(7)
    expect(stats.totals.tokens).toBe(0)
    expect(stats.totals.topModel).toBeNull()
    expect(stats.byModel).toEqual([])
    expect(stats.daily.length).toBe(7)
    expect(stats.heatmap.length).toBe(84)
    store.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: FAIL — `store.getUsageStats is not a function`.

- [ ] **Step 3a: Add the method to the `ConversationStore` type**

In `src/service/conversation-store.ts`, add to the `export type ConversationStore = { ... }` block (next to `getSessionTasks`):

```ts
  getUsageStats(rangeDays: number): import('@shared/types/usage').UsageStats
```

- [ ] **Step 3b: Add imports at the top of `conversation-store.ts`**

```ts
import { createLogger } from '@shared/logger'
import type { UsageStats } from '@shared/types/usage'
import { HEATMAP_DAYS } from '@shared/types/usage'
import { currentStreak, dayKeysEndingAt, rangeCutoffMs, zeroFillDaily } from './usage-stats'
```

Then add the module logger after the imports (if not already present):

```ts
const log = createLogger({ process: 'service' }).child({ component: 'conversation-store' })
```

- [ ] **Step 3c: Implement `getUsageStats` in the returned object**

Add this method to the object returned by `createConversationStore` (e.g. right after `getSessionTasks`):

```ts
    getUsageStats(rangeDays) {
      const t0 = Date.now()
      const range: 7 | 30 = rangeDays === 7 ? 7 : 30
      log.info({ msg: 'getUsageStats', rangeDays: range })
      try {
        const now = new Date()
        const cutoff = rangeCutoffMs(now, range)
        const heatmapCutoff = rangeCutoffMs(now, HEATMAP_DAYS)

        const totalsRow = db
          .prepare(
            `SELECT
               COALESCE(SUM(json_extract(used, '$.tokens')), 0)   AS tokens,
               COALESCE(SUM(json_extract(used, '$.usdCents')), 0)  AS usdCents,
               COUNT(DISTINCT session_id)                          AS sessions,
               COUNT(DISTINCT date(created_at/1000,'unixepoch','localtime')) AS activeDays
             FROM tasks WHERE created_at >= ?`
          )
          .get(cutoff) as { tokens: number; usdCents: number; sessions: number; activeDays: number }

        const messagesRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM task_events
             WHERE ts >= ? AND json_extract(event, '$.kind') = 'llm.message'`
          )
          .get(cutoff) as { n: number }

        const modelRows = db
          .prepare(
            `SELECT json_extract(s.provider_snapshot, '$.model') AS model,
                    COALESCE(SUM(json_extract(t.used, '$.tokens')), 0) AS tokens
             FROM tasks t JOIN sessions s ON s.id = t.session_id
             WHERE t.created_at >= ?
             GROUP BY model
             HAVING tokens > 0
             ORDER BY tokens DESC`
          )
          .all(cutoff) as { model: string; tokens: number }[]

        const dailyRows = db
          .prepare(
            `SELECT date(created_at/1000,'unixepoch','localtime') AS date,
                    COALESCE(SUM(json_extract(used, '$.tokens')), 0) AS tokens
             FROM tasks WHERE created_at >= ? GROUP BY date`
          )
          .all(heatmapCutoff) as { date: string; tokens: number }[]

        const totalTokens = totalsRow.tokens
        const byModel = modelRows.map((r) => ({
          model: r.model ?? 'unknown',
          tokens: r.tokens,
          pct: totalTokens > 0 ? Math.round((r.tokens / totalTokens) * 1000) / 10 : 0,
        }))

        const rangeKeys = dayKeysEndingAt(now, range)
        const rangeKeySet = new Set(rangeKeys)
        const heatmapKeys = dayKeysEndingAt(now, HEATMAP_DAYS)
        const activeKeys = new Set(dailyRows.filter((r) => r.tokens > 0).map((r) => r.date))

        const result: UsageStats = {
          rangeDays: range,
          totals: {
            tokens: totalTokens,
            usdCents: totalsRow.usdCents,
            sessions: totalsRow.sessions,
            messages: messagesRow.n,
            activeDays: totalsRow.activeDays,
            currentStreak: currentStreak(activeKeys, now),
            topModel: byModel[0] ?? null,
          },
          daily: zeroFillDaily(
            dailyRows.filter((r) => rangeKeySet.has(r.date)),
            rangeKeys
          ),
          byModel,
          heatmap: zeroFillDaily(dailyRows, heatmapKeys),
        }
        log.info({ msg: 'getUsageStats ok', rangeDays: range, tokens: totalTokens, durationMs: Date.now() - t0 })
        return result
      } catch (err) {
        log.error({ msg: 'getUsageStats failed', rangeDays: range, err: err instanceof Error ? err.message : String(err) })
        throw err
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/service/conversation-store.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/service/conversation-store.ts src/service/conversation-store.test.ts
git add src/service/conversation-store.ts src/service/conversation-store.test.ts
git commit -m "feat(usage): aggregate usage stats in conversation-store"
```

---

## Task 4: Thread `getUsageStats` through the RPC chain

**Files:**
- Modify: `src/shared/types/service-ipc.ts` (add method name)
- Modify: `src/service/session-manager.ts` (type + impl)
- Modify: `src/service/dispatcher.ts` (case) and `src/service/dispatcher.test.ts` (route test)
- Modify: `src/main/service-client.ts` (type + impl)
- Modify: `src/main/ipc/swarm-ipc.ts` (handler + removeHandler)
- Modify: `src/preload/index.ts` (bridge method)
- Modify: `src/shared/types/ui.ts` (`SwarmBridge` type)
- Modify: `src/renderer/src/lib/api.ts` (`swarmApi.getUsageStats`)

**Interfaces:**
- Consumes: `getUsageStats(rangeDays)` on `ConversationStore` (Task 3); `UsageStats` from `@shared/types/usage`.
- Produces: `swarmApi.getUsageStats(rangeDays: number): Promise<UsageStats>` and `window.swarm.usage.get(rangeDays)`.

- [ ] **Step 1: Write the failing dispatcher test**

Add to `src/service/dispatcher.test.ts` (use the file's existing fake-manager setup; mirror an existing case like `getSessionTasks`). If the file has a shared `makeDispatcher`/fake manager, extend it with `getUsageStats`. Minimal standalone version:

```ts
  it('routes getUsageStats to the manager', () => {
    const stats = { rangeDays: 30 } as unknown
    const manager = { getUsageStats: (n: number) => ({ ...(stats as object), called: n }) }
    const dispatch = createDispatcher({
      manager: manager as never,
      registerProvider: () => {},
      setMcpServers: async () => {},
      getMcpStatus: () => [],
      setWebSearchConfig: () => {},
      listSkills: () => [],
      saveSkill: () => ({ ok: true, skills: [] }) as never,
      deleteSkill: () => ({ ok: true, skills: [] }) as never,
      listMemory: () => [],
    })
    expect(dispatch('getUsageStats', [7])).toEqual({ rangeDays: 30, called: 7 })
  })
```

(If `dispatcher.test.ts` already has a `baseConfig` helper, prefer: `dispatch('getUsageStats', [7])` against a config whose `manager.getUsageStats` is a `vi.fn()` returning a sentinel, and assert the fn was called with `7`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/service/dispatcher.test.ts`
Expected: FAIL — `unknown method: getUsageStats` (thrown by the default case).

- [ ] **Step 3a: Add the method name to the union**

`src/shared/types/service-ipc.ts` — add to `ServiceMethod`:

```ts
  | 'getUsageStats'
```

- [ ] **Step 3b: Add to `SessionManager` (type + impl)**

`src/service/session-manager.ts` — in `export type SessionManager = { ... }` add:

```ts
  getUsageStats(rangeDays: number): import('@shared/types/usage').UsageStats
```

In the object returned by `createSessionManager` (next to `getSessionTasks`):

```ts
    getUsageStats(rangeDays) {
      return store.getUsageStats(rangeDays)
    },
```

(`store` is already in scope via `SessionManagerConfig`.)

- [ ] **Step 3c: Add the dispatcher case**

`src/service/dispatcher.ts` — add before `default:`:

```ts
      case 'getUsageStats': {
        const [rangeDays] = args as [number]
        return manager.getUsageStats(rangeDays)
      }
```

- [ ] **Step 3d: Add to `service-client.ts` (type + impl)**

In `export type ServiceClient = { ... }` (next to `getSessionTasks`):

```ts
  getUsageStats(rangeDays: number): Promise<import('@shared/types/usage').UsageStats>
```

In the returned object:

```ts
    getUsageStats(rangeDays) {
      return call('getUsageStats', [rangeDays])
    },
```

- [ ] **Step 3e: Add the main IPC handler**

`src/main/ipc/swarm-ipc.ts` — define the handler next to `getSessionTasks`:

```ts
  const getUsageStats = (_e: Electron.IpcMainInvokeEvent, rangeDays: number) => serviceClient.getUsageStats(rangeDays)
```

Register it next to `swarm:getSessionTasks`:

```ts
  ipcMain.handle('swarm:getUsageStats', getUsageStats)
```

And remove it in `dispose()` next to the other `swarm:*` removals:

```ts
      ipcMain.removeHandler('swarm:getUsageStats')
```

- [ ] **Step 3f: Expose it on the preload bridge**

`src/preload/index.ts` — inside the `swarm` object, after the `sessions: { ... }` block, add:

```ts
  usage: {
    get: (rangeDays: number) =>
      ipcRenderer.invoke('swarm:getUsageStats', rangeDays) as Promise<import('../shared/types/usage').UsageStats>,
  },
```

- [ ] **Step 3g: Add it to the `SwarmBridge` type**

`src/shared/types/ui.ts` — in `export type SwarmBridge = { ... }`, after the `sessions: { ... }` block:

```ts
  usage: {
    get(rangeDays: number): Promise<import('./usage').UsageStats>
  }
```

- [ ] **Step 3h: Add the renderer API wrapper**

`src/renderer/src/lib/api.ts` — add the import and the method:

```ts
import type { UsageStats } from '@shared/types/usage'
```

```ts
  getUsageStats: (rangeDays: number): Promise<UsageStats> => window.swarm.usage.get(rangeDays),
```

- [ ] **Step 4: Run tests + typecheck to verify it passes**

Run: `npm test -- src/service/dispatcher.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors (the chain is type-consistent end to end). *(If `typecheck:web` reports an unknown route, that is Task 5's `usage.tsx` — not yet created here; this task touches no route file.)*

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/shared/types/service-ipc.ts src/service/session-manager.ts src/service/dispatcher.ts src/service/dispatcher.test.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/shared/types/ui.ts src/renderer/src/lib/api.ts
git add src/shared/types/service-ipc.ts src/service/session-manager.ts src/service/dispatcher.ts src/service/dispatcher.test.ts src/main/service-client.ts src/main/ipc/swarm-ipc.ts src/preload/index.ts src/shared/types/ui.ts src/renderer/src/lib/api.ts
git commit -m "feat(usage): wire getUsageStats through the RPC chain"
```

---

## Task 5: Renderer route, view shell, formatters, sidebar link

**Files:**
- Create: `src/renderer/src/lib/usage-format.ts`
- Test: `src/renderer/src/lib/usage-format.test.ts`
- Create: `src/renderer/src/routes/usage.tsx`
- Create: `src/renderer/src/components/views/usage-view.tsx`
- Modify: `src/renderer/src/components/app-sidebar.tsx`

**Interfaces:**
- Consumes: `swarmApi.getUsageStats` (Task 4); `UsageStats`, `UsageRange` from `@shared/types/usage`.
- Produces:
  - `formatCount(n: number): string` — `Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })`.
  - `formatCost(usdCents: number): string` — `$` + dollars, 2 dp.
  - `heatmapShade(tokens: number, max: number): 0 | 1 | 2 | 3 | 4` — quantile bucket (0 when tokens===0).
  - `UsageView` React component (default-exported named export) rendering the dashboard.

- [ ] **Step 1: Write the failing formatter test**

```ts
// src/renderer/src/lib/usage-format.test.ts
import { describe, expect, it } from 'vitest'
import { formatCost, formatCount, heatmapShade } from './usage-format'

describe('usage-format', () => {
  it('formats counts compactly (zh-CN 万)', () => {
    expect(formatCount(2_418_000)).toContain('万')
    expect(formatCount(0)).toBe('0')
  })

  it('formats cost from usdCents', () => {
    expect(formatCost(1234)).toBe('$12.34')
    expect(formatCost(0)).toBe('$0.00')
  })

  it('buckets heatmap shades 0..4', () => {
    expect(heatmapShade(0, 100)).toBe(0)
    expect(heatmapShade(100, 100)).toBe(4)
    expect(heatmapShade(1, 100)).toBe(1)
    expect(heatmapShade(50, 0)).toBe(0) // guard divide-by-zero
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/lib/usage-format.test.ts`
Expected: FAIL — cannot find module `./usage-format`.

- [ ] **Step 3a: Implement the formatters**

```ts
// src/renderer/src/lib/usage-format.ts
const countFmt = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

export function formatCount(n: number): string {
  return countFmt.format(n)
}

export function formatCost(usdCents: number): string {
  return `$${(usdCents / 100).toFixed(2)}`
}

/** Quantile-ish bucket 0..4; 0 only when tokens === 0. */
export function heatmapShade(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}
```

- [ ] **Step 3b: Run the formatter test to confirm green**

Run: `npm test -- src/renderer/src/lib/usage-format.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3c: Create the view shell (cards + range toggle; charts come in Task 6)**

```tsx
// src/renderer/src/components/views/usage-view.tsx
import { useEffect, useState } from 'react'
import type { UsageRange, UsageStats } from '@shared/types/usage'
import { Activity, BarChart3, CalendarCheck, CalendarDays, Flame, MessageSquare, MessagesSquare } from 'lucide-react'

import { swarmApi } from '@/lib/api'
import { formatCost, formatCount } from '@/lib/usage-format'
import { cn } from '@/lib/utils'

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
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">时间范围</h2>
        <div className="flex rounded-lg border p-0.5">
          {([7, 30] as const).map((r) => (
            <button
              key={r}
              className={cn(
                'rounded-md px-3 py-1 text-sm transition-colors',
                rangeDays === r ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
              )}
              onClick={() => setRangeDays(r)}
              type="button"
            >
              最近 {r} 天
            </button>
          ))}
        </div>
      </header>

      {error ? <div className="rounded-lg border border-destructive/40 p-4 text-destructive text-sm">{error}</div> : null}
      {loading && !stats ? <div className="text-muted-foreground text-sm">加载中…</div> : null}
      {stats && stats.totals.tokens === 0 ? (
        <div className="rounded-lg border p-8 text-center text-muted-foreground text-sm">还没有用量数据</div>
      ) : null}

      {stats ? (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <StatCard icon={<Flame size={15} />} label="tokens 用量" value={formatCount(stats.totals.tokens)} />
          <StatCard
            icon={<BarChart3 size={15} />}
            label="花费"
            value={formatCost(stats.totals.usdCents)}
            sub={<span className="rounded bg-muted px-1.5 py-0.5">估算 · 自定义模型价格可能不准</span>}
          />
          <StatCard icon={<MessagesSquare size={15} />} label="会话数量" value={String(stats.totals.sessions)} />
          <StatCard icon={<MessageSquare size={15} />} label="消息数量" value={String(stats.totals.messages)} />
          <StatCard icon={<CalendarDays size={15} />} label="活跃天数" value={String(stats.totals.activeDays)} />
          <StatCard icon={<CalendarCheck size={15} />} label="当前连续天数" value={String(stats.totals.currentStreak)} />
          <StatCard
            icon={<Activity size={15} />}
            label="最常用模型"
            value={stats.totals.topModel?.model ?? '—'}
            sub={stats.totals.topModel ? `占比 ${stats.totals.topModel.pct}%` : undefined}
          />
        </section>
      ) : null}
      {/* Task 6 inserts <ActivityHeatmap/>, <DailyTokenChart/>, <ModelUsageDonut/> here, gated on `stats`. */}
    </div>
  )
}
```

- [ ] **Step 3d: Create the route**

```tsx
// src/renderer/src/routes/usage.tsx
import { createFileRoute } from '@tanstack/react-router'

import { UsageView } from '@/components/views/usage-view'

export const Route = createFileRoute('/usage')({ component: UsageView })
```

- [ ] **Step 3e: Add the sidebar link**

`src/renderer/src/components/app-sidebar.tsx` — import the icon (merge into the existing lucide import):

```ts
import { ArrowLeft, ArrowRight, BarChart3, Settings, Sparkles } from 'lucide-react'
```

Add a new `SidebarMenuItem` immediately above the Skills item:

```tsx
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className="flex items-center gap-2"
                  // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over route const
                  to={'/usage' as any}
                >
                  <BarChart3 />
                  <span>用量统计</span>
                </Link>
              }
              tooltip="用量统计"
            />
          </SidebarMenuItem>
```

- [ ] **Step 4: Regenerate the route tree, typecheck, and verify in the app**

The `TanStackRouterVite` plugin regenerates `src/renderer/src/routeTree.gen.ts` on dev/build start. Launch the app with the **run-desktop** skill (or `npm run dev`) so the tree picks up `/usage`, then:

Run: `npm run typecheck`
Expected: no errors (the `/usage` route now exists in the generated tree).

Run: `npm test -- src/renderer/src/lib/usage-format.test.ts`
Expected: PASS.

Use the **run-desktop** skill to open the app, click "用量统计" in the sidebar, and screenshot. Expected: range toggle (最近 7 天 / 最近 30 天) and the seven stat cards render; the 花费 card shows the 估算 badge; empty state shows "还没有用量数据" only when there is no usage.

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/renderer/src/lib/usage-format.ts src/renderer/src/lib/usage-format.test.ts src/renderer/src/routes/usage.tsx src/renderer/src/components/views/usage-view.tsx src/renderer/src/components/app-sidebar.tsx
git add src/renderer/src/lib/usage-format.ts src/renderer/src/lib/usage-format.test.ts src/renderer/src/routes/usage.tsx src/renderer/src/components/views/usage-view.tsx src/renderer/src/components/app-sidebar.tsx src/renderer/src/routeTree.gen.ts
git commit -m "feat(usage): add /usage route, stat cards, and sidebar link"
```

---

## Task 6: Charts — heatmap, daily trend, model donut

**Files:**
- Modify: `src/renderer/src/components/views/usage-view.tsx` (add three subcomponents + render them)

**Interfaces:**
- Consumes: `UsageStats` (`stats.daily`, `stats.heatmap`, `stats.byModel`); `heatmapShade` from `@/lib/usage-format`; `ChartContainer`, `ChartTooltip`, `ChartTooltipContent` from `@/components/ui/chart`; `Bar`, `BarChart`, `Cell`, `Pie`, `PieChart`, `XAxis` from `recharts`.
- Produces: rendered `ActivityHeatmap`, `DailyTokenChart`, `ModelUsageDonut` inside `UsageView`.

Notes:
- Donut slice colors: cycle a fixed palette `['var(--chart-1)','var(--chart-2)','var(--chart-3)','var(--chart-4)','var(--chart-5)']` (these CSS vars are defined by the shadcn theme; confirm in `chart.tsx`/global CSS, else fall back to literal hex from the mockup: `#5b9cff`, `#34c759`).
- Heatmap is a CSS grid of 7 rows (weekdays) × N columns; iterate `stats.heatmap` in order, shade via `heatmapShade(tokens, max)` where `max = Math.max(...heatmap.map(d=>d.tokens), 0)`.

- [ ] **Step 1: Add chart imports to `usage-view.tsx`**

```ts
import { Bar, BarChart, Cell, Pie, PieChart, XAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { heatmapShade } from '@/lib/usage-format'
```

- [ ] **Step 2: Add the three subcomponents (above `UsageView`)**

```tsx
const SHADE_CLASS = ['bg-muted', 'bg-primary/30', 'bg-primary/50', 'bg-primary/70', 'bg-primary'] as const
const SLICE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

function ActivityHeatmap({ days }: { days: { date: string; tokens: number }[] }): React.JSX.Element {
  const max = Math.max(0, ...days.map((d) => d.tokens))
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">活跃热力图</h3>
      <div className="grid grid-flow-col grid-rows-7 gap-1">
        {days.map((d) => (
          <div
            key={d.date}
            className={cn('h-3 w-3 rounded-[3px]', SHADE_CLASS[heatmapShade(d.tokens, max)])}
            title={`${d.date}: ${d.tokens}`}
          />
        ))}
      </div>
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
          <Bar dataKey="tokens" fill="var(--color-tokens)" radius={2} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

function ModelUsageDonut({
  byModel,
  total,
}: {
  byModel: { model: string; tokens: number; pct: number }[]
  total: number
}): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">模型用量</h3>
      <div className="flex items-center gap-6">
        <ChartContainer className="h-[200px] w-[200px]" config={{}}>
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={byModel} dataKey="tokens" nameKey="model" innerRadius={60} outerRadius={90} strokeWidth={2}>
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
              <span className="w-12 text-right">{total > 0 ? m.pct : 0}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render them in `UsageView`**

Replace the `{/* Task 6 inserts ... */}` comment with:

```tsx
      {stats && stats.totals.tokens > 0 ? (
        <>
          <ActivityHeatmap days={stats.heatmap} />
          <DailyTokenChart daily={stats.daily} />
          <ModelUsageDonut byModel={stats.byModel} total={stats.totals.tokens} />
        </>
      ) : null}
```

- [ ] **Step 4: Typecheck + verify in the app**

Run: `npm run typecheck`
Expected: no errors. *(If `var(--chart-1)` etc. are undefined in the theme, the bars/slices render transparent — swap `SLICE_COLORS` and the chart `color` to the literal hex fallbacks noted above and re-run.)*

Use the **run-desktop** skill: open the app on "用量统计". Expected: heatmap grid (较少→较多 legend), daily token bar chart with a hover tooltip, and a model donut with a legend showing per-model tokens + 占比 %. Compare against the reference mockups (images 1 & 2). Screenshot.

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write src/renderer/src/components/views/usage-view.tsx
git add src/renderer/src/components/views/usage-view.tsx
git commit -m "feat(usage): add heatmap, daily trend, and model donut charts"
```

---

## Final verification

- [ ] Run the full suite: `npm test` → expected: all pass.
- [ ] Run `npm run typecheck` → expected: no errors.
- [ ] Run `npm run lint` → expected: clean (or only pre-existing warnings).
- [ ] Use the **run-desktop** skill end-to-end: launch, navigate to 用量统计, toggle 最近 7 天 / 最近 30 天 (cards + charts refetch), screenshot both ranges; confirm the empty state on a fresh DB.

## Spec coverage check

- Summary cards (7, incl. 估算 cost) — Tasks 3 (data) + 5 (UI). ✓
- Activity heatmap (84-day) — Tasks 3 + 6. ✓
- Daily token bar trend (range-scoped) — Tasks 3 + 6. ✓
- Per-model donut (range-scoped) — Tasks 3 + 6. ✓
- 7/30 range toggle — Task 5. ✓
- New `/usage` route + sidebar link — Task 5. ✓
- RPC method threaded as `getSessionTasks` — Task 4. ✓
- SQL aggregation, local-time bucketing, streak helper — Tasks 2 + 3. ✓
- Logging on the new service path — Task 3. ✓
- Tests: store aggregation, streak/helpers, dispatcher route, formatters — Tasks 2–5. ✓
- Chinese labels, zh-CN compact numbers — Tasks 5 + 6. ✓
