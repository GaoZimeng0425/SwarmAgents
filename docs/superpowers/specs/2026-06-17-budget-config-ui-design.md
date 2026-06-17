# Global cost-control UI (Feature B) — design

**Date:** 2026-06-17
**Status:** Approved. Follow-up to the sub-agent-types spec (Feature A).

## Problem

Task budgets are hardcoded in `session-manager.ts`:
- main task (`submitGoal`): `{ tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 }`
- sub task (`spawnChild`): `{ tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 }`

There is no way for a user to adjust how much an agent may spend. Feature B makes
both budgets user-configurable from a Settings page, applying to the main agent and
all sub-agents.

## Approach

Mirror the existing **web-search config** vertical slice (renderer Settings page →
main persists → pushes to the service → live config read at task creation), but
**without** web-search's encryption/redaction — budget numbers are not secrets, so
there is a single config shape used on disk, over IPC, and in the service.

## Data model

New `src/shared/types/budgets.ts`:
```ts
import { ResourceBudgetSchema } from './task'

export const BudgetConfigSchema = z.object({
  main: ResourceBudgetSchema,   // budget for top-level (submitGoal) tasks
  sub: ResourceBudgetSchema,    // budget for spawned sub-agent tasks
})
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>

export const defaultBudgetConfig = (): BudgetConfig => ({
  main: { tokens: 100_000, calls: 50, wallMs: 600_000, usdCents: 200 },
  sub: { tokens: 50_000, calls: 25, wallMs: 300_000, usdCents: 100 },
})
```
The defaults are exactly today's hardcoded values, so behavior is unchanged until a
user edits them.

## Main process — `src/main/budgets/`

A compact subsystem mirroring `src/main/web-search/` minus encryption:
- `store.ts` — plaintext `<userData>/budgets.json`; `load()` is forgiving (bad/missing
  file → defaults, logged at warn), `save()` atomic (tmp → rename). No file watch
  (the page is the only writer; no hand-edit story needed).
- `service.ts` — holds state; `get()`, `set(config)` (validate via schema, persist,
  then advance in-memory state and emit), `onStateChanged(cb)`.
- `ipc.ts` — `wireBudgetsIpc({ service })`: `ipcMain.handle('budgets:get')`,
  `ipcMain.handle('budgets:set', …)` (Zod-validate the payload), and broadcast the
  new config to all windows on `budgets:stateChanged`.
- `index.ts` — `initBudgets()`: build store + service + wire ipc; returns
  `{ service, dispose }`.

`src/main/index.ts`: `const budgets = await initBudgets()`, pass `budgets: budgets.service`
into `wireSwarmIpc`, dispose on shutdown.

## Main ↔ Service bridge

`src/main/ipc/swarm-ipc.ts` (mirror the web-search bridge): push the persisted config
to the service on boot and on every change:
```ts
void serviceClient.setBudgetConfig(budgets.get())
const offBudgets = budgets.onStateChanged(() => serviceClient.setBudgetConfig(budgets.get()))
```
`src/main/service-client.ts`: add `setBudgetConfig(config: BudgetConfig): Promise<void>`
→ `call('setBudgetConfig', [config])`.

## Service process

- `src/shared/types/service-ipc.ts`: add `'setBudgetConfig'` to `ServiceMethod`.
- `src/service/dispatcher.ts`: add `setBudgetConfig(config: BudgetConfig): void` to the
  deps and a `case 'setBudgetConfig'`.
- `src/service/index.ts`: hold a live `let budgetConfig = defaultBudgetConfig()`; in the
  dispatcher wiring `setBudgetConfig: (c) => { budgetConfig = c }`; pass
  `getBudgetConfig: () => budgetConfig` into `createSessionManager`.
- `src/service/session-manager.ts`: `SessionManagerConfig` gains optional
  `getBudgetConfig?: () => BudgetConfig`. Replace the two hardcoded budget literals:
  - `submitGoal`: `budget: cfg.getBudgetConfig?.().main ?? defaultBudgetConfig().main`
  - `spawnChild`: `budget: cfg.getBudgetConfig?.().sub ?? defaultBudgetConfig().sub`
  The fallback keeps `createSessionManager` usable in tests that omit the getter.

## Renderer

- `src/shared/types/ui.ts`: add `BudgetsBridge` (`get(): Promise<BudgetConfig>`,
  `set(c: BudgetConfig): Promise<BudgetsSetResult>`, `onStateChanged(cb)`).
- `src/preload/index.ts`: `BUDGETS_STATE_CHANNEL = 'budgets:stateChanged'`; a `budgets`
  bridge object; add it to the exposed `swarm` object.
- `src/renderer/src/hooks/use-budgets.ts`: initial `get()` + subscribe to
  `onStateChanged`, returning the current `BudgetConfig`.
- `src/renderer/src/components/views/budgets-view.tsx`: a form for the two budgets
  (main / sub), each with Tokens, Tool calls, Wall time, Max cost. Edit in friendly
  units — **seconds** (×1000 → `wallMs`) and **USD** (×100 → `usdCents`) — converting
  at the IPC boundary. Local draft state; "Save" calls `window.swarm.budgets.set(draft)`;
  a "Reset to defaults" button sets `defaultBudgetConfig()`.
- `src/renderer/src/routes-settings/budgets.tsx`: file-based route `/budgets`
  (auto-picked by the TanStack codegen).
- `src/renderer/src/routes-settings/__root.tsx`: add `{ to: '/budgets', label: 'Budgets' }`
  to `TABS`.

## Error handling

- `store.load` never throws — bad/missing file falls back to defaults with a warn.
- `budgets:set` Zod-validates; invalid payload → `{ ok: false, code: 'invalid', message }`,
  persist failure → `{ ok: false, code: 'persist_failed', message }` (mirrors web-search).
- The service ignores nothing silently: `setBudgetConfig` logs at info on apply.

## Testing

- `src/shared/types/budgets.test.ts` — schema accepts defaults; rejects negative/missing.
- `src/main/budgets/store.test.ts` — round-trip save/load; missing/corrupt file → defaults.
- Extend `session-manager` test (or add one): with a `getBudgetConfig` returning custom
  values, a spawned child carries the configured `sub` budget; without the getter the
  default applies.

Run via `npm test`.
