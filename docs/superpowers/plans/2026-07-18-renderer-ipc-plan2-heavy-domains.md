# Renderer-IPC Single-Sourcing — Plan 2 (Heavy Domains)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the bilibili / providers / mcp-servers / web-search / budgets domains (54 invoke channels + 5 event senders) onto the Plan-1 mechanism, and put `@swarm/protocol` into the typecheck gate.

**Architecture:** Per spec §4 (docs/superpowers/specs/2026-07-17-renderer-ipc-single-source-design.md): each domain adds its `RendererIpcSignatures` entries, switches its preload members to the existing typed `invoke`, and migrates its main-side ipc.ts to `createIpcRegistrar` + `sendToAllWindows`. The mechanism (tables, helpers, wire.ts) already exists — this plan is pure domain migration plus one gate improvement. Authoritative channel strings: docs/superpowers/specs/2026-07-17-renderer-ipc-channel-inventory.md (committed, reviewed). Renderer-facing signatures: the bridge types in `packages/protocol/src/types/ui.ts` (BilibiliBridge :230, ProvidersBridge :311, McpBridge :341, WebSearchBridge :357, BudgetsBridge :385) — frozen, do not edit them.

**Tech Stack:** TypeScript 5.9, Electron ipcMain/ipcRenderer, vitest, pnpm + turbo.

## Global Constraints

- Work ONLY inside the worktree `/Users/gaozimeng/Learn/macOS/SwarmAgents/.claude/worktrees/renderer-ipc-plan2` (node_modules symlinked — never `pnpm install`/`rebuild`).
- Channel strings FROZEN — when switching a preload member, the string comes from the raw `ipcRenderer.invoke('<literal>', …)` line being replaced, in place; the table entry must use the identical string (cross-check against the inventory doc on any doubt — inventory wins).
- Bridge types in `types/ui.ts` and `preload/index.d.ts` are untouched; renderer files untouched.
- Table entries are type-only; `result` types state the WIRE truth (what the main handler actually resolves), not the bridge's declared type — where the bridge declares `Promise<void>` but the handler resolves a value, the preload member await-wraps (`async … { await invoke(…) }`), exactly like Plan 1's six void-contract members. Event payload types state the wire shape the sender posts (Plan 1's navigate-settings lesson).
- Do NOT apply biome's unsafe fix for `noConfusingVoidType` on `result: void` entries (it breaks `TypedIpcHandler` assignability); the warnings are non-blocking.
- Tests: `npm test -- <filter>` from the worktree root (pnpm `--config.verifyDepsBeforeRun=false` if the wall appears). NEVER `git stash` (shared stack; use `git show <base>:<path>` for base comparisons). Typecheck: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck`. Never `git add -A`.
- Comments/commits in English. Format touched files only: `npx biome check --write <file...>`.

---

### Task 1: Table entries for the five domains + protocol typecheck gate

**Files:**
- Modify: `packages/protocol/src/renderer-ipc.ts` (append 5 domain sections)
- Modify: `packages/protocol/package.json` (add typecheck script)
- Test: `packages/protocol/src/renderer-ipc.test.ts` (extend)

**Interfaces:**
- Consumes: bridge member signatures from `packages/protocol/src/types/ui.ts:230-389` (authoritative renderer-facing args); channel strings + handler file:line from the inventory doc's bilibili/providers/mcp-servers/web-search/budgets tables; existing `Passthrough<M>` pattern (NOT applicable here — all five domains are main-owned, zero service passthroughs).
- Produces: 54 new `RendererIpcSignatures` keys consumed by Tasks 2–4; `@swarm/protocol` gains a `typecheck` script that turbo picks up (making `renderer-ipc.test.ts`'s `expectTypeOf` assertions a standing gate — final-review recommendation from Plan 1).

- [ ] **Step 1: Add the protocol typecheck script and verify it fails-fast on type errors**

In `packages/protocol/package.json`, add to `"scripts"`: `"typecheck": "tsc --noEmit"`. Protocol's tsconfig already includes `src/**/*` (test files included). Verify the gate is real: temporarily add `const _x: number = 'oops'` to `renderer-ipc.test.ts`, run `pnpm --filter @swarm/protocol typecheck` → expect ONE error; remove the line, re-run → clean. (This is the TDD step for the gate itself.)

- [ ] **Step 2: Extend the type test (failing)**

Append to `packages/protocol/src/renderer-ipc.test.ts` inside the existing describe:

```ts
it('plan-2 domain entries model the wire, not the bridge facade', () => {
  // bilibili:save takes the full video + summary (fav deletion needs the fav* ids)
  expectTypeOf<RendererIpcSignatures['bilibili:save']['args']>().toEqualTypeOf<
    [import('./types/bilibili').BiliVideo, import('./types/bilibili').BiliSummary]
  >()
  // providers mutations resolve ProvidersSetResult on the wire
  expectTypeOf<RendererIpcSignatures['providers:setKey']['result']>().toEqualTypeOf<
    import('./types/ui').ProvidersSetResult
  >()
  // budgets:set resolves the SetResult union
  expectTypeOf<RendererIpcSignatures['budgets:set']['result']>().toEqualTypeOf<
    import('./types/ui').BudgetsSetResult
  >()
})
```

If a channel string in this test doesn't match the inventory (e.g. the real key is `swarm:bilibili:save` or `bilibili:saveToObsidian`), correct the TEST to the inventory's string first — the inventory is authoritative for strings; the assertion shapes are the requirement.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @swarm/protocol typecheck`
Expected: FAIL — the three keys don't exist in `RendererIpcSignatures` yet.

- [ ] **Step 4: Append the five domain sections to `RendererIpcSignatures`**

For each domain, one table section. The procedure per entry (54 total; counts per domain are a hard gate: bilibili 24, providers 17, mcp 6, webSearch 5, budgets 2):

1. Channel string: from the inventory row (which cites the `ipcMain.handle` site — spot-check any surprising one).
2. `args`: from the bridge member's parameters in `types/ui.ts:230-389` (they ARE the renderer-facing truth; e.g. `setKey(id: string, key: string)` → `args: [string, string]`).
3. `result`: from the main handler's actual resolved type at the inventory's cited file:line (open the handler; e.g. providers mutations resolve `ProvidersSetResult`; bilibili handlers mostly resolve the bridge's declared types directly; where a handler resolves a value but the bridge says `Promise<void>`, record the handler truth and list that member for Task 2's await-wrap set).

Worked examples to anchor the pattern (exact code — remaining entries follow identically):

```ts
  // ---- bilibili/ipc.ts (24 channels; strings per inventory) ----
  'bilibili:status': { args: []; result: BiliLoginStatus }
  'bilibili:login': { args: []; result: BiliLoginStatus }
  'bilibili:save': { args: [BiliVideo, BiliSummary]; result: BiliSaveResult }
  'bilibili:transcribe': { args: [string]; result: BiliTranscribeResult }
  // ... remaining 20 bilibili entries per procedure
  // ---- providers/ipc.ts (17 channels) ----
  'providers:get': { args: []; result: ProvidersStateView }
  'providers:setKey': { args: [string, string]; result: ProvidersSetResult }
  'providers:addCustomProvider': { args: [AddCustomProviderInput]; result: ProvidersAddResult }
  // ... remaining 14 providers entries
  // ---- mcp-servers/ipc.ts (6 channels; getStatus migrated in Plan 1) ----
  'mcp:list': { args: []; result: McpServerConfig[] }
  'mcp:add': { args: [Omit<McpServerConfig, 'id'>]; result: McpMutationResult & { id?: string } }
  // ... remaining 4 mcp entries
  // ---- web-search/ipc.ts (5 channels) ----
  'webSearch:get': { args: []; result: WebSearchConfigView }
  'webSearch:setKey': { args: [WebSearchKeyId, string]; result: WebSearchSetResult }
  // ... remaining 3 webSearch entries
  // ---- budgets/ipc.ts (2 channels) ----
  'budgets:get': { args: []; result: BudgetConfig }
  'budgets:set': { args: [BudgetConfig]; result: BudgetsSetResult }
```

(The `// ... remaining` lines above are NOT permission to skip — they mark where the per-entry procedure applies; the commit must contain all 54, and Step 6's count gate enforces it. Import types with `import type` from their real homes — grep protocol for each type's exporter; `ProvidersSetResult`/`BudgetsSetResult`/`WebSearchSetResult`/`WebSearchKeyId` live in `types/ui.ts`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @swarm/protocol typecheck` → clean (test assertions now compile).
Run: `npm test -- renderer-ipc.test` → PASS.

- [ ] **Step 6: Count gate**

Count keys per prefix across the WHOLE file (events-table keys share prefixes, so the expected numbers below already include them):
```bash
for p in bilibili: providers: mcp: webSearch: budgets:; do printf '%s ' "$p"; grep -c "^  '$p" packages/protocol/src/renderer-ipc.ts; done
```
Expected totals: `bilibili:` **25** (24 new invoke + 1 Plan-1 event `bilibili:transcribe:progress`), `providers:` **18** (17 + event `providers:stateChanged`), `mcp:` **9** (6 new + Plan-1 `mcp:getStatus` + events `mcp:status`/`mcp:configChanged`), `webSearch:` **6** (5 + event), `budgets:` **3** (2 + event). Reconcile any surprise against the inventory before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/renderer-ipc.ts packages/protocol/src/renderer-ipc.test.ts packages/protocol/package.json
git commit -m "feat(protocol): plan-2 domain entries in the renderer-IPC table; protocol joins the typecheck gate"
```

---

### Task 2: Preload switch for the five domains

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

**Interfaces:**
- Consumes: the 54 new table keys (Task 1); the existing `invoke` helper (Plan 1).
- Produces: bilibili/providers/mcp/webSearch/budgets bridge members routed through `invoke`; bridge object shape unchanged.

- [ ] **Step 1: Switch the members**

For every member of `bilibili`, `providers`, `mcp` (the 6 config members — `getStatus` is already typed), `webSearch`, `budgets`: replace `ipcRenderer.invoke('<literal>', …) as Promise<…>` with `invoke('<literal>', …)` and delete the cast. Subscriptions (`onTranscribeProgress`, `onStateChanged`, `onConfigChanged`, `onStatus`) were already switched in Plan 1 — untouched. Members whose bridge contract is `Promise<void>` but whose table result is a value (Task 1's recorded await-wrap set) become `async (…) => { await invoke('…', …) }`.

- [ ] **Step 2: Typecheck (the real gate) + renderer tests**

Run: `find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && pnpm typecheck` → clean. Any error = table-vs-reality mismatch: fix the TABLE only if the inventory/handler proves it wrong (report which); otherwise fix the preload line.
Run: `npm test -- apps/desktop/src/renderer` → same pass set as branch base (bilibili-view and providers-related suites are the sensitive ones).

- [ ] **Step 3: Self-review greps**

```bash
grep -c "ipcRenderer.invoke('" apps/desktop/src/preload/index.ts
```
Expected: **38** (gmail 14 + calendar 10 + weather 3 + workbench 11 — Plan 3's domains). List any deviation in the report.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(preload): bilibili/providers/mcp/webSearch/budgets routed through the typed invoke"
```

---

### Task 3: Migrate `bilibili/ipc.ts`

**Files:**
- Modify: `apps/desktop/src/main/bilibili/ipc.ts`

**Interfaces:**
- Consumes: `createIpcRegistrar`, `sendToAllWindows`, `TypedIpcHandler` from `apps/desktop/src/main/ipc/wire.ts`; the 24 bilibili table keys. Reference migration: `apps/desktop/src/main/ipc/swarm-ipc.ts` (Plan 1's 43-channel example of the exact pattern).
- Produces: unchanged export contract (`wireBilibiliIpc`-style function + dispose — read the file for the exact export name before starting).

- [ ] **Step 1: Migrate**

`const ipc = createIpcRegistrar()`; all 24 `ipcMain.handle` → `ipc.handle` (bodies unchanged; param types tightened only where the compiler forces it — keep runtime guards). The `bilibili:transcribe:progress` window-loop sender becomes `sendToAllWindows('bilibili:transcribe:progress', p)`; delete the local channel const if now unused. dispose → `ipc.dispose()` + any non-IPC teardown preserved verbatim.

- [ ] **Step 2: Verify + commit**

`grep -c "ipcMain.handle(\|removeHandler" apps/desktop/src/main/bilibili/ipc.ts` → 0. Typecheck clean. `npm test -- apps/desktop/src/main` → same pass set as base.

```bash
git add apps/desktop/src/main/bilibili/ipc.ts
git commit -m "refactor(main): bilibili ipc through the typed registrar"
```

---

### Task 4: Migrate providers / mcp-servers / web-search / budgets ipc.ts

**Files:**
- Modify: `apps/desktop/src/main/providers/ipc.ts`, `apps/desktop/src/main/mcp-servers/ipc.ts`, `apps/desktop/src/main/web-search/ipc.ts`, `apps/desktop/src/main/budgets/ipc.ts`

**Interfaces:**
- Consumes: same wire.ts exports; the providers(17)/mcp(6)/webSearch(5)/budgets(2) table keys.
- Produces: unchanged export contracts (each file's `wire*Ipc(args): { dispose }`-style shape — read each before editing).

- [ ] **Step 1: Migrate all four files**

Same pattern as Task 3 per file: registrar swap, bodies unchanged, compiler-forced param tightenings only. Each file's `onStateChanged`-style broadcast loop (`PROVIDERS_STATE_CHANNEL`, `MCP_CONFIG_CHANGED_CHANNEL`, `WEB_SEARCH_STATE_CHANNEL`, `BUDGETS_STATE_CHANNEL` window loops) becomes `sendToAllWindows('<event-table-key>', payload)` with the local const deleted (the event keys already exist in `RendererIpcEvents` since Plan 1 — providers:stateChanged / mcp:configChanged / webSearch:stateChanged / budgets:stateChanged; cross-check literals against the events table, they were verified in Plan 1). mcp-servers also broadcasts `mcp:status` — if its sender is a window loop in this file, migrate it the same way.

- [ ] **Step 2: Verify + commit**

`grep -rc "ipcMain.handle(\|removeHandler" <the four files>` → all 0. Typecheck clean. `npm test -- apps/desktop/src/main` → same pass set.

```bash
git add apps/desktop/src/main/providers/ipc.ts apps/desktop/src/main/mcp-servers/ipc.ts apps/desktop/src/main/web-search/ipc.ts apps/desktop/src/main/budgets/ipc.ts
git commit -m "refactor(main): providers/mcp/web-search/budgets ipc through the typed registrar"
```

---

### Task 5: Full regression + format

**Files:** none new; formatting-only diffs possible.

- [ ] **Step 1: Biome over touched files**

```bash
npx biome check --write $(git diff --name-only <plan-base>..HEAD -- '*.ts' | tr '\n' ' ')
```
(`<plan-base>` = the commit this worktree branched from; `git merge-base develop HEAD`.) Do NOT accept unsafe fixes.

- [ ] **Step 2: Full suite + typecheck**

`npm test` → same failure set as develop (host EADDRINUSE / gmail spy / mobile jest — attribute anything else, don't fix silently). Tsbuildinfo-clean `pnpm typecheck` → clean, now INCLUDING `@swarm/protocol` (verify protocol appears in turbo's task list output).

- [ ] **Step 3: Spot smoke (no full run-desktop needed — mechanism proven in Plan 1)**

`npm test -- bilibili-view` and `npm test -- providers` (renderer suites for the two heaviest migrated domains) → pass. These exercise the bridge shapes through the mocked window.swarm and would catch member-shape drift.

- [ ] **Step 4: Commit deltas if any**

```bash
git add -u packages/protocol apps/desktop/src
git status --short   # no stray .js/.d.ts
git commit -m "style: biome format for renderer-ipc plan 2" || echo "nothing to format"
```

- [ ] **Step 5: Hand off**

Do not merge — finishing-a-development-branch handles integration (rebase develop + ff-only after verifying the main checkout).
