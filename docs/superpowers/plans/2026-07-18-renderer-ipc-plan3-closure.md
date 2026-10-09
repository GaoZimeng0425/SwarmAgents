# Renderer-IPC Single-Sourcing — Plan 3 (Remaining Domains + Closure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate gmail/calendar/weather/workbench (38 channels), the `system:updateReady` sender, close out with the spec's grep gates — completing the renderer→main leg — plus the protocol devDependency fix from Plan 2's review.

**Architecture:** Per spec §4 final phase. Same mechanism as Plans 1–2 (table entries → preload switch → main registrar). Workbench is the one structurally novel file: it already has a local `handle` wrapper + channels array (a proto-registrar) AND deliberate zod validation at the boundary — the migration swaps its wrapper for `createIpcRegistrar` while KEEPING every zod parse. After this plan: preload has zero raw `ipcRenderer.invoke`/`on` outside the helpers; main has zero bare `ipcMain.handle` and zero window-loop sends outside `wire.ts`.

**Tech Stack:** TypeScript 5.9, Electron, vitest, pnpm + turbo.

## Global Constraints

- Work ONLY inside `/Users/gaozimeng/Learn/macOS/SwarmAgents/.claude/worktrees/renderer-ipc-plan3` (node_modules symlinked — never `pnpm install`/`rebuild`).
- Channel strings FROZEN (in-place from replaced lines; inventory doc `docs/superpowers/specs/2026-07-17-renderer-ipc-channel-inventory.md` wins on doubt). Bridge types (`types/ui.ts`), `index.d.ts`, renderer files untouched.
- Table `result` types = wire truth from handlers; event payloads = wire shape senders post.
- KEEP all existing runtime zod parses and coercion guards in handlers (workbench's are deliberate; spec allows defense in depth).
- Do NOT apply biome's unsafe `noConfusingVoidType` fix.
- Tests: scoped vitest (P2 Task 1's report documents the invocation; `npm test -- <filter>` doesn't forward). Typecheck: `/usr/bin/find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm --config.verifyDepsBeforeRun=false typecheck`. NEVER `git stash`; never `git add -A`; comments/commits in English.

---

### Task 1: Table entries (38) + protocol devDependencies

**Files:**
- Modify: `packages/protocol/src/renderer-ipc.ts`, `packages/protocol/src/renderer-ipc.test.ts`, `packages/protocol/package.json`

**Interfaces:**
- Consumes: bridge types `types/ui.ts` — GmailBridge :265 (14 invoke members), CalendarBridge :297 (10), WeatherBridge :373 (3 invoke: getConfig/setConfig/getForecast), WorkbenchBridge :391 (11); channel strings/handler sites per inventory; wire-truth results from each domain's ipc.ts + service.
- Produces: 38 new `RendererIpcSignatures` keys (Tasks 2–4); protocol declares `typescript` + `vitest` devDependencies matching sibling packages' declaration style (open `apps/desktop/package.json` and copy the version-spec style exactly — catalog or pinned).

- [ ] **Step 1: Extend the type test (failing)**

Append inside the existing describe in `renderer-ipc.test.ts`:

```ts
it('plan-3 domain entries model the wire', () => {
  expectTypeOf<RendererIpcSignatures['gmail:search']['args']>().toEqualTypeOf<[string, number]>()
  expectTypeOf<RendererIpcSignatures['calendar:updateLocal']['args']>().toEqualTypeOf<
    [string, Partial<import('./types/ui').CalendarLocalInput>]
  >()
  expectTypeOf<RendererIpcSignatures['weather:getForecast']['args']>().toEqualTypeOf<[number | null, number | null]>()
  expectTypeOf<RendererIpcSignatures['workbench:createTask']['result']>().toEqualTypeOf<
    import('./types/workbench').WorkbenchMutationResult
  >()
})
```

(Correct any string against the inventory first — it is authoritative.)
Run: `pnpm --filter @swarm/protocol typecheck` → FAIL (missing keys).

- [ ] **Step 2: Append the four domain sections**

Same 3-rule procedure as Plan 2 (string ← inventory; args ← bridge member; result ← handler wire truth). Worked anchors:

```ts
  // ---- gmail/ipc.ts (14 channels) ----
  'gmail:getStatus': { args: []; result: GmailConfigView }
  'gmail:search': { args: [string, number]; result: GmailThread[] }
  'gmail:saveThreadAnalysis': { args: [string, ThreadAnalysisPayload]; result: void }
  'gmail:listInboxPage': { args: [number]; result: { threads: GmailThread[]; total: number } }
  // ... remaining 10 gmail entries per procedure
  // ---- calendar/ipc.ts (10 channels) ----
  'calendar:getStatus': { args: []; result: CalendarConfigView }
  'calendar:listInRange': { args: [number, number]; result: CalendarEvent[] }
  'calendar:updateLocal': { args: [string, Partial<CalendarLocalInput>]; result: CalendarEvent | null }
  // ... remaining 7 calendar entries
  // ---- weather/ipc.ts (3 channels) ----
  'weather:getConfig': { args: []; result: WeatherConfigView }
  'weather:setConfig': { args: [WeatherConfig]; result: WeatherSetResult }
  'weather:getForecast': { args: [number | null, number | null]; result: WeatherForecastResult }
  // ---- workbench/ipc.ts (11 channels; zod-validated handlers — results include the invalid branch) ----
  'workbench:getAll': { args: []; result: WorkbenchData }
  'workbench:createTask': { args: [CreateTaskInput]; result: WorkbenchMutationResult }
  'workbench:updateTask': { args: [string, UpdateTaskInput]; result: WorkbenchMutationResult }
  'workbench:addColumn': { args: [AddColumnInput]; result: WorkbenchMutationResult }
  // ... remaining 7 workbench entries
```

Notes: workbench handlers' zod-fail branch returns `{ ok: false, message }` which is assignable to `WorkbenchMutationResult` — no special union needed. `gmail:listRecent` takes the bridge's `[{ limit: number; label?: string }]` object arg. The `weather:getForecast` result is `WeatherForecastResult` (types/ui.ts:369), not the raw forecast.

- [ ] **Step 3: devDependencies**

Add `typescript` and `vitest` to `packages/protocol/package.json` devDependencies, copying the exact version-spec style used by `apps/desktop/package.json` (catalog reference or pinned semver — mirror it verbatim). Do NOT run pnpm install in the worktree; the symlinked store already hosts both (typecheck proves resolution).

- [ ] **Step 4: Gates + commit**

`pnpm --filter @swarm/protocol typecheck` → clean. Count gate:
```bash
for p in gmail: calendar: weather: workbench:; do printf '%s ' "$p"; grep -c "^  '$p" packages/protocol/src/renderer-ipc.ts; done
```
Expected (incl. Plan-1 event keys): `gmail:` **15** (14 + `gmail:stateChanged`), `calendar:` **11** (10 + event), `weather:` **4** (3 + `weather:forecastChanged`), `workbench:` **12** (11 + event).

```bash
git add packages/protocol/src/renderer-ipc.ts packages/protocol/src/renderer-ipc.test.ts packages/protocol/package.json
git commit -m "feat(protocol): plan-3 domain entries; declare typescript/vitest devDeps"
```

---

### Task 2: Preload switch (final 38)

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: the 38 new keys; existing `invoke` helper.
- Produces: preload fully table-typed — **zero** raw `ipcRenderer.invoke('` remain.

- [ ] **Step 1: Switch all gmail/calendar/weather/workbench members**

Mechanical form (`invoke('<literal>', …)`, casts deleted). Await-wrap rule applies if any bridge-void member's table result is a value (from Task 1's report — expected: `gmail:syncNow`/`calendar:syncNow` handlers, check; gmail:saveThreadAnalysis is void-void). Subscriptions already typed (Plan 1) — untouched, including weather's `onConfigChanged` no-op stub (leave the stub as-is; it is not a wire subscription).

- [ ] **Step 2: Gates**

Typecheck clean (table-vs-reality: fix table only with inventory/handler proof, report it).
```bash
grep -c "ipcRenderer.invoke('" apps/desktop/src/preload/index.ts   # expected: 0
grep -c "ipcRenderer.on(" apps/desktop/src/preload/index.ts        # expected: 1 (inside subscribe)
```
Renderer suite: same pass set as branch base.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(preload): gmail/calendar/weather/workbench through the typed invoke — preload fully table-typed"
```

---

### Task 3: Migrate gmail/calendar/weather ipc.ts + updateReady sender

**Files:**
- Modify: `apps/desktop/src/main/gmail/ipc.ts`, `apps/desktop/src/main/calendar/ipc.ts`, `apps/desktop/src/main/weather/ipc.ts`, `apps/desktop/src/main/system/auto-update.ts`

**Interfaces:**
- Consumes: wire.ts helpers; the gmail/calendar/weather table keys; reference pattern `apps/desktop/src/main/bilibili/ipc.ts` @ HEAD.
- Produces: unchanged export contracts (`wireGmailIpc`/`wireCalendarIpc`/`wireWeatherIpc` shapes; `setupAutoUpdate(): void`).

- [ ] **Step 1: The three domain files**

Registrar swaps (bodies unchanged; keep every `String(...)`/`Number(...)` coercion that still typechecks); state-broadcast loops → `sendToAllWindows('gmail:stateChanged' | 'calendar:stateChanged' | 'weather:forecastChanged', payload)` with local consts deleted if unused. NOTE these files also contain the MainMethod `rpcHandlers` tables (service→main RPC, typed in the method-table branch) — those are NOT ipcMain.handle sites; do not touch them. dispose → `ipc.dispose()` + preserved unsubscribes.

- [ ] **Step 2: auto-update.ts**

Replace the update-downloaded window loop with `sendToAllWindows('system:updateReady', undefined)` (the events table types it `void`; the explicit `undefined` satisfies the generic — behavior identical to today's payloadless `send(channel)`). Delete `UPDATE_READY_CHANNEL`. `setupAutoUpdate` signature unchanged.

- [ ] **Step 3: Gates + commit**

`grep -c "ipcMain.handle(\|removeHandler" <three ipc files>` → all 0; `grep -c "getAllWindows" apps/desktop/src/main/system/auto-update.ts` → 0. Typecheck clean; main suite same pass set.

```bash
git add apps/desktop/src/main/gmail/ipc.ts apps/desktop/src/main/calendar/ipc.ts apps/desktop/src/main/weather/ipc.ts apps/desktop/src/main/system/auto-update.ts
git commit -m "refactor(main): gmail/calendar/weather ipc + updateReady sender through the typed wire"
```

---

### Task 4: Migrate workbench/ipc.ts (novel: replace the proto-registrar, keep zod)

**Files:**
- Modify: `apps/desktop/src/main/workbench/ipc.ts`

**Interfaces:**
- Consumes: wire.ts helpers; the 11 workbench keys.
- Produces: unchanged export contract (`wireWorkbenchIpc(args: { service }): { dispose }`; the `WorkbenchData` re-export stays).

- [ ] **Step 1: Swap the local wrapper**

Delete the local `handle` helper + `channels` array. Register each of the 11 channels explicitly via `ipc.handle('workbench:…', handler)` — unrolled, not looped (the typed registrar's per-channel generics don't fit a loop without a cast, and 11 explicit lines match every other migrated file). KEEP every `*.safeParse` validation and its `{ ok: false, message }` fail branch byte-for-byte; param types tighten from `unknown` to the table types where the compiler allows (zod parse still runs — the file's own comment says the renderer is treated as untrusted here; preserve that comment). State loop → `sendToAllWindows('workbench:stateChanged', data)`; delete `STATE_CHANGED_CHANNEL`. dispose → `unsubscribe()` + `ipc.dispose()`. Keep the `log.info({ msg: 'workbench IPC wired' })` line but drop the now-gone `channels` field from it (or log the static count 11).

- [ ] **Step 2: Gates + commit**

`grep -c "ipcMain\." apps/desktop/src/main/workbench/ipc.ts` → 0. Typecheck clean; workbench renderer/main suites same pass set.

```bash
git add apps/desktop/src/main/workbench/ipc.ts
git commit -m "refactor(main): workbench ipc through the typed registrar, zod boundary preserved"
```

---

### Task 5: Closure gates + full regression

**Files:** none new (report-only verification; formatting deltas possible).

- [ ] **Step 1: The spec's closure gates (all must hold)**

```bash
# 1. No bare ipcMain.handle outside wire.ts (0 hits):
grep -rn "ipcMain.handle(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.' | grep -v 'ipc/wire.ts'
# 2. ipcMain.on: only the dev 'ping' listener in main/index.ts survives:
grep -rn "ipcMain.on(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.'
# 3. No window-LOOP sends outside wire.ts — every surviving webContents.send must be a
#    targeted single-window send listed in the inventory's Events section (e.g.
#    open-settings.ts's swarm:navigate-settings, main-window's swarm:navigate flush).
#    Any getAllWindows+send combo outside wire.ts = gate failure:
grep -rn "webContents.send(" apps/desktop/src/main --include='*.ts' | grep -v '\.test\.' | grep -v 'ipc/wire.ts'
# 4. Preload fully helper-routed:
grep -c "ipcRenderer.invoke('" apps/desktop/src/preload/index.ts   # 0
grep -c "ipcRenderer.on(" apps/desktop/src/preload/index.ts        # 1
```
Record each gate's output verbatim in the report; justify every gate-3 survivor against the inventory row (file:line), confirming it is a targeted send, not a loop.

- [ ] **Step 2: Full regression**

Biome scoped over `git diff --name-only $(git merge-base develop HEAD)..HEAD -- '*.ts'` (decline unsafe fixes). Full `npm test` → attribute every failure against the known set (host EADDRINUSE / gmail spy / mobile jest / bilibili-view contamination flake). Tsbuildinfo-clean typecheck → clean incl. `@swarm/protocol`.

- [ ] **Step 3: Domain smoke (scoped suites)**

Scoped vitest: gmail-inbox-view, calendar (whatever calendar view suites exist — locate via `ls apps/desktop/src/renderer/src/components/views/*calendar*`), workbench/rail suites. Same pass set as base (NOTE: develop has 6 pre-existing rail/weather failures from the workbench merge era — attribute against branch base, not zero).

- [ ] **Step 4: Commit deltas if any + hand off**

```bash
git add -u packages/protocol apps/desktop/src
git status --short   # no stray .js/.d.ts
git commit -m "style: biome format for renderer-ipc plan 3" || echo "nothing to format"
```
Do not merge — finishing-a-development-branch handles integration.
