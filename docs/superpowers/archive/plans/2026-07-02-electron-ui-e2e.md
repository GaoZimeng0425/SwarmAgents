# Electron UI E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright Electron-mode UI e2e suite to `apps/desktop` covering real window boot, preload IPC contracts, composer submit (to-submit boundary, no real LLM), provider onboarding, and session navigation.

**Architecture:** Playwright `_electron.launch` boots the prod build (`out/main/index.js`) with a per-test isolated `--user-data-dir` and a `SWARM_E2E=1` env var that bypasses the single-instance lock. A shared `fixtures.ts` exposes `{ electronApp, page }`. Six spec files map to the six cases in the design spec.

**Tech Stack:** `@playwright/test` + `playwright` (Electron mode), electron-vite prod build, electron@43 runtime (better-sqlite3 + sqlite-vec already rebuilt to its ABI by `electron-builder install-app-deps`).

## Global Constraints

- **Worktree**: implement in `worktree-electron-ui-e2e`. All paths below are relative to the worktree root unless prefixed with `apps/desktop/`.
- **Language**: code comments and commit messages in English; conversational replies in Chinese.
- **No real LLM**: never configure a real API key. The only key used is the literal `sk-e2e-dummy`. Submit cases assert UI feedback up to task creation, never LLM success.
- **Don't break the app ABI**: never run `pnpm rebuild better-sqlite3`. If native modules misbehave, restore with `npm run postinstall` (from `apps/desktop`).
- **Run tests via Electron node**: unit tests via `npm test` (from `apps/desktop`), not bare `npx vitest`.
- **prod build path**: Playwright points at `apps/desktop/out/main/index.js` (the `main` field in `apps/desktop/package.json`). It must exist before any e2e run — `test:e2e` builds it first.
- **Scoped formatting**: never run `pnpm check`/`format` (it reformats the whole repo). Scope with `npx biome check --write <file>` if needed.

## Verified DOM locators (from source)

| Element | Locator | Source |
|---------|---------|--------|
| No-provider banner text | `getByText('No API key configured')` | `no-provider-banner.tsx:12` |
| Open Settings button | `getByRole('button', { name: 'Open Settings' })` | `no-provider-banner.tsx:13-15` |
| Provider key input | `getByPlaceholder('输入 API Key')` (first match) | `providers-view.tsx:334` |
| Composer textarea | `locator('textarea').first()` | `prompt-input.tsx:838` (no aria-label) |
| Submit button | `getByRole('button', { name: 'Submit' })` | `prompt-input.tsx:1079` (`aria-label='Submit'` when not generating) |
| IPC bridges | `window.swarm.providers/agents/budgets/mcp/sessions` | `preload/index.ts` (confirmed) |

Builtin provider ids: `'anthropic'` and `'openai'` (from `ProvidersBridge` doc comment).

---

### Task 1: Install Playwright deps and add `test:e2e` script

**Files:**
- Modify: `apps/desktop/package.json` (devDependencies + scripts)

**Interfaces:**
- Produces: `@playwright/test` + `playwright` resolvable from `apps/desktop`; `"test:e2e"` script.

- [ ] **Step 1: Add dependencies (aligned to existing `playwright-core@^1.61.1`)**

From the worktree root:

```bash
pnpm --filter desktop add -D @playwright/test@^1.61.1 playwright@^1.61.1
```

If the filter name resolves differently, run from `apps/desktop`:

```bash
cd apps/desktop && pnpm add -D @playwright/test@^1.61.1 playwright@^1.61.1
```

- [ ] **Step 2: Add the `test:e2e` script**

In `apps/desktop/package.json`, add to `"scripts"` (keep existing scripts untouched):

```json
"test:e2e": "electron-vite build && playwright test"
```

- [ ] **Step 3: Verify install**

```bash
cd apps/desktop && npx playwright --version
```

Expected: prints a version line like `Version 1.61.x`. No "command not found".

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore(desktop): add @playwright/test + test:e2e script for UI e2e"
```

---

### Task 2: Bypass single-instance lock under `SWARM_E2E`

**Files:**
- Modify: `apps/desktop/src/main/index.ts:32`

**Interfaces:**
- Produces: when `process.env.SWARM_E2E` is truthy, a second Electron instance (the e2e run) is not rejected by the single-instance lock even if the user's app is open.

- [ ] **Step 1: Edit the single-instance guard**

In `apps/desktop/src/main/index.ts`, change:

```ts
if (!app.requestSingleInstanceLock()) {
```

to:

```ts
// E2E runs launch a second instance alongside the user's app; skip the lock
// only when the e2e harness explicitly opts in. Production is unaffected.
if (!process.env.SWARM_E2E && !app.requestSingleInstanceLock()) {
```

- [ ] **Step 2: Verify the existing test suite still passes**

```bash
cd apps/desktop && npm test
```

Expected: PASS (unchanged behavior when `SWARM_E2E` is unset). If a test fails, it is a regression from this change — revert and investigate before proceeding.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "fix(main): bypass single-instance lock when SWARM_E2E is set"
```

---

### Task 3: Playwright config, electron fixture, and smoke case

This task is the load-bearing one: the smoke case validates the entire setup (build chain, electron runtime loading better-sqlite3 + sqlite-vec, single-instance bypass, window creation).

**Files:**
- Create: `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/e2e/fixtures.ts`
- Create: `apps/desktop/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: `test` and `expect` exports from `./e2e/fixtures`, used by every later spec. The fixture auto-launches an isolated Electron app per test and exposes `{ electronApp, page }`.

- [ ] **Step 1: Write `apps/desktop/playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
```

- [ ] **Step 2: Write `apps/desktop/e2e/fixtures.ts`**

```ts
// Shared Electron fixture: each test gets a freshly launched app on an
// isolated temp user-data-dir, torn down (and cleaned up) afterwards.
import { test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

type Fixtures = { electronApp: ElectronApplication; page: Page }

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(resolve(tmpdir(), 'swarm-e2e-'))
    const app = await electron.launch({
      executablePath: require('electron') as string,
      args: [resolve('out/main/index.js'), `--user-data-dir=${userDataDir}`],
      env: { ...process.env, SWARM_E2E: '1' },
    })
    await use(app)
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect }
```

- [ ] **Step 3: Write `apps/desktop/e2e/smoke.spec.ts` (Case 1)**

```ts
import { test, expect } from './fixtures'

// Case 1 — smoke: validates build chain, electron runtime loading
// better-sqlite3 + sqlite-vec, single-instance bypass, and window creation.
test('app boots and renders the composer', async ({ page }) => {
  await expect(page.locator('textarea').first()).toBeVisible()
})
```

- [ ] **Step 4: Build and run the smoke case**

```bash
cd apps/desktop && npx electron-vite build && npx playwright test smoke
```

Expected: `1 passed`. If this fails, the failure is the signal — diagnose by category:

- `Cannot find module ... better-sqlite3` / crash on native module → run `npm run postinstall` (from `apps/desktop`) and retry. Do NOT `pnpm rebuild better-sqlite3`.
- `sqlite-vec` load error → confirm `out/main/` ships the loadable extension; check `src/main` sqlite setup path resolution against the prod layout.
- Window never appears (`firstWindow` timeout) → run `SWARM_E2E=1 npx electron out/main/index.js --user-data-dir=/tmp/swarm-e2e-manual` and read the devtools / stderr.
- Single-instance lock rejection → confirm Task 2's edit is in place and `SWARM_E2E=1` is set.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/playwright.config.ts apps/desktop/e2e/
git commit -m "test(e2e): add playwright config, electron fixture, smoke case"
```

---

### Task 4: Onboarding cases (banner + provider key)

**Files:**
- Create: `apps/desktop/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: `test`, `expect` from `./fixtures`.
- Produces: (none — leaf spec.)

- [ ] **Step 1: Write `apps/desktop/e2e/onboarding.spec.ts` (Cases 2 & 3)**

```ts
import { test, expect } from './fixtures'

// Case 2 — empty state: no-provider banner is visible and opens settings
// to the providers tab.
test('no-provider banner opens settings to providers', async ({ page }) => {
  await expect(page.getByText('No API key configured')).toBeVisible()
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByPlaceholder('输入 API Key').first()).toBeVisible()
})

// Case 3 — entering a key persists it via the providers IPC. We assert
// through window.swarm.providers.get() to bypass UI state-sync timing.
test('entering an API key persists via IPC', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Settings' }).click()
  const keyInput = page.getByPlaceholder('输入 API Key').first()
  await keyInput.fill('sk-e2e-dummy')
  // providers-view persists on Enter; if a future change switches to blur,
  // replace with keyInput.blur() — the assertion below is the real contract.
  await keyInput.press('Enter')

  const state = await page.evaluate(() =>
    (window as unknown as { swarm: { providers: { get: () => Promise<{ providers: Array<{ hasKey: boolean }> }> } } }).swarm.providers.get(),
  )
  expect(state.providers.filter((p) => p.hasKey).length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run the onboarding cases**

```bash
cd apps/desktop && npx playwright test onboarding
```

Expected: `2 passed`. If Case 3 fails on the assertion: open Playwright UI mode (`npx playwright test onboarding --ui`) and confirm whether `providers-view.tsx:320` persists on Enter or on blur; switch `press('Enter')` to `blur()` accordingly. The IPC assertion itself is correct.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/onboarding.spec.ts
git commit -m "test(e2e): add onboarding cases (banner + provider key)"
```

---

### Task 5: IPC contract sampling case

**Files:**
- Create: `apps/desktop/e2e/ipc-contract.spec.ts`

**Interfaces:**
- Consumes: `test`, `expect` from `./fixtures`.

- [ ] **Step 1: Write `apps/desktop/e2e/ipc-contract.spec.ts` (Case 4)**

```ts
import { test, expect } from './fixtures'

// Case 4 — preload → main IPC contract sampling. Asserts return shapes for
// representative bridges; if any channel is renamed, this case fails.
test('IPC bridges return expected shapes', async ({ page }) => {
  const swarm = (window: typeof globalThis) =>
    (window as unknown as {
      swarm: {
        providers: { get: () => Promise<{ providers: unknown[] }> }
        agents: { list: () => Promise<unknown[]> }
        budgets: { get: () => Promise<Record<string, unknown>> }
        mcp: { list: () => Promise<unknown[]> }
      }
    }).swarm

  const providers = await page.evaluate(() => swarm(window).providers.get())
  expect(Array.isArray(providers.providers)).toBe(true)

  const agents = await page.evaluate(() => swarm(window).agents.list())
  expect(Array.isArray(agents)).toBe(true)

  const budgets = await page.evaluate(() => swarm(window).budgets.get())
  expect(budgets).toEqual(expect.any(Object))

  const mcp = await page.evaluate(() => swarm(window).mcp.list())
  expect(Array.isArray(mcp)).toBe(true)
})
```

- [ ] **Step 2: Run the IPC contract case**

```bash
cd apps/desktop && npx playwright test ipc-contract
```

Expected: `1 passed`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/ipc-contract.spec.ts
git commit -m "test(e2e): add IPC contract sampling case"
```

---

### Task 6: Composer submit case (to-submit boundary)

**Files:**
- Create: `apps/desktop/e2e/composer.spec.ts`

**Interfaces:**
- Consumes: `test`, `expect` from `./fixtures`; builtin provider id `'anthropic'`.

- [ ] **Step 1: Write `apps/desktop/e2e/composer.spec.ts` (Case 5)**

```ts
import { test, expect } from './fixtures'

// Case 5 — composer submits a goal and the user message renders. We seed a
// dummy provider key via IPC to unlock the composer, then drive the real UI.
// We do NOT wait for an LLM response (dummy key); we assert only that submit
// produces a task and the user message appears in the transcript.
test('composer submits and renders the user message', async ({ page }) => {
  await page.evaluate(async () => {
    const w = (window as unknown as {
      swarm: {
        providers: {
          setKey: (id: string, key: string) => Promise<unknown>
          setActive: (id: string | null) => Promise<unknown>
        }
      }
    }).swarm
    await w.providers.setKey('anthropic', 'sk-e2e-dummy')
    await w.providers.setActive('anthropic')
  })

  // Banner disappears once providers state refreshes.
  await expect(page.getByText('No API key configured')).toBeHidden()

  await page.locator('textarea').first().fill('hello from e2e')
  await page.getByRole('button', { name: 'Submit' }).click()

  await expect(page.getByText('hello from e2e').first()).toBeVisible({ timeout: 15_000 })
})
```

- [ ] **Step 2: Run the composer case**

```bash
cd apps/desktop && npx playwright test composer
```

Expected: `1 passed`. If the user-message assertion times out: run `--ui`, confirm the submit actually fired (watch for the task panel / transcript mount). If `Submit` button name mismatches (e.g. app entered `isGenerating` and label flipped to `Stop`), assert on the textarea's form-submit instead: `await page.locator('textarea').first().press('Enter')`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/composer.spec.ts
git commit -m "test(e2e): add composer submit case (to-submit boundary)"
```

---

### Task 7: Navigation case (session appears after submit)

**Files:**
- Create: `apps/desktop/e2e/navigation.spec.ts`

**Interfaces:**
- Consumes: `test`, `expect` from `./fixtures`; `window.swarm.sessions.list`.

- [ ] **Step 1: Write `apps/desktop/e2e/navigation.spec.ts` (Case 6)**

```ts
import { test, expect } from './fixtures'

// Case 6 — after a submit, a session is persisted (IPC) and appears in the
// sidebar. The click-into-detail interaction depends on session-list DOM;
// the durable contract is "submit creates a session the sidebar shows".
test('submit creates a session visible in the sidebar', async ({ page }) => {
  await page.evaluate(async () => {
    const w = (window as unknown as {
      swarm: {
        providers: {
          setKey: (id: string, key: string) => Promise<unknown>
          setActive: (id: string | null) => Promise<unknown>
        }
      }
    }).swarm
    await w.providers.setKey('anthropic', 'sk-e2e-dummy')
    await w.providers.setActive('anthropic')
  })
  await expect(page.getByText('No API key configured')).toBeHidden()

  await page.locator('textarea').first().fill('nav test goal')
  await page.getByRole('button', { name: 'Submit' }).click()

  // Session is persisted via IPC.
  const sessions = await page.evaluate(() =>
    (window as unknown as {
      swarm: { sessions: { list: () => Promise<Array<{ id: string; taskCount: number }> }> }
    }).swarm.sessions.list(),
  )
  expect(sessions.length).toBeGreaterThan(0)

  // Click-into: use UI mode to confirm the actual sidebar item locator from
  // session-list.tsx, then assert the detail route mounts. Placeholder for
  // first-session navigation (locator settled during implementation):
  //   const firstItem = page.locator('[data-slot="session-item"]').first()
  //   await firstItem.click()
  //   await expect(page.locator('[data-session-detail]')).toBeVisible()
})
```

> **Note for the implementer:** the durable assertions (provider unlock + session persisted via `sessions.list()`) are complete above. The click-into-detail is left as a guided stub because `session-list.tsx` does not currently expose a stable test id — run `npx playwright test navigation --ui`, inspect the sidebar item, and add the two commented lines with the real selector. If the sidebar item has no `data-slot`, prefer `getByRole`/`getByText` of the session title.

- [ ] **Step 2: Run the navigation case**

```bash
cd apps/desktop && npx playwright test navigation
```

Expected: `1 passed` (the two durable assertions). The click-into lines are added during this step.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e/navigation.spec.ts
git commit -m "test(e2e): add navigation case (session persisted + visible)"
```

---

### Task 8: Full-suite acceptance and fault-injection check

**Files:**
- (none created; verification only, plus a temporary revert of a channel name to prove Case 4 catches regressions.)

- [ ] **Step 1: Run the full e2e suite via the production script**

```bash
cd apps/desktop && npm run test:e2e
```

Expected: `6 passed` (retries permitted on CI-class flakes, but local should be clean). The script rebuilds via `electron-vite build` first.

- [ ] **Step 2: Fault-injection — confirm Case 4 catches a broken IPC channel**

Temporarily rename the `agents:list` handler in `apps/desktop/src/main/ipc/` (or wherever it is registered) to `agents:listX`, rebuild, and rerun:

```bash
cd apps/desktop && npx electron-vite build && npx playwright test ipc-contract
```

Expected: Case 4 **fails** on the `agents.list()` assertion. Then revert the rename:

```bash
git checkout -- apps/desktop/src/main/ipc/
```

Re-run `npm run test:e2e` and confirm `6 passed` again.

- [ ] **Step 3: Confirm unit tests still green**

```bash
cd apps/desktop && npm test
```

Expected: PASS (the single-instance-lock edit and any incidental touches have not broken existing tests).

- [ ] **Step 4: Final commit (if any cleanup)**

If the fault-injection revert left the tree dirty, nothing to commit (it was reverted). Otherwise:

```bash
git status --short
```

Expected: clean tree.

---

## Self-Review

**1. Spec coverage** — each design-spec case maps to a task:
- Case 1 (smoke) → Task 3 ✓
- Case 2 (empty-state banner) → Task 4 ✓
- Case 3 (provider key) → Task 4 ✓
- Case 4 (IPC contract) → Task 5 ✓
- Case 5 (composer submit) → Task 6 ✓
- Case 6 (navigation) → Task 7 ✓
- Single-instance lock bypass → Task 2 ✓
- Deps + `test:e2e` script → Task 1 ✓
- Acceptance criteria (fault injection, full-suite green) → Task 8 ✓

**2. Placeholder scan** — the only guided stub is the click-into-detail in Task 7, explicitly because `session-list.tsx` exposes no stable test id; it is framed with concrete fallback strategies and a UI-mode command, not a bare "TODO". All other steps contain complete, runnable code and exact commands.

**3. Type consistency** — the `window.swarm` bridge shape is cast identically across Tasks 4/5/6/7 (`providers.get/setKey/setActive`, `agents.list`, `budgets.get`, `mcp.list`, `sessions.list`), all matching `preload/index.ts`. Builtin id `'anthropic'` used consistently in Tasks 6 and 7. Locator set verified against source (table at top).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-02-electron-ui-e2e.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
