# Extract @swarm/protocol + @swarm/shared (Phase 2+3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the cross-process type system + RPC client into `@swarm/protocol`, and the platform-neutral pure logic into `@swarm/shared`, as importable workspace packages — then rewrite every `@shared/types/*`, `@shared/agents/*`, `@shared/constants/*`, `@shared/tokens`, `@shared/system-session` import across `apps/desktop` to point at the new packages. Desktop behavior stays identical; `@shared/events` and `@shared/logger` remain desktop-internal.

**Architecture:** Source-path consumption (tsconfig `paths` + vite/vitest aliases point straight at `packages/*/src`) — no package build step yet, since only desktop consumes them; built dist can come later when the extension/RN bundlers need it. Each package exports a barrel `index.ts`. A grep-based boundary lint guarantees neither package imports Node/electron/react/native modules or any `apps/*` path. `git mv` preserves history; a sed codemod rewrites imports in bulk; `tsc --noEmit` gates each task.

**Tech Stack:** pnpm workspaces, TypeScript project references, zod (protocol's only runtime dep), turbo, vitest, electron-vite, biome.

**Spec:** `docs/superpowers/specs/2026-07-01-multiplatform-structure-design.md` (§5 packages, §8.3 boundary enforcement, §10 Phase 2+3).

## Global Constraints

- **Language:** Code comments and commit messages in English. Conversation in Chinese.
- **History:** Move files with `git mv`. Never copy+delete.
- **Tests:** `npm test` (Electron node). NEVER bare `npx vitest`. NEVER `pnpm rebuild better-sqlite3` — `pnpm --filter @swarm/desktop run postinstall` rebuilds native modules against Electron's ABI.
- **Format:** Scope with `npx biome check --write <file>` — never `pnpm check`/`pnpm format` (reformats the whole repo — memory `reference_biome_check_hardcodes_dot`).
- **Source-path consumption:** `@swarm/protocol` and `@swarm/shared` are consumed via tsconfig `paths` + electron-vite/vitest aliases pointing at `packages/*/src`. No build/dist step in this plan.
- **Boundary invariant:** `@swarm/protocol` and `@swarm/shared` MUST NOT import `electron`, `better-sqlite3`, `sqlite-vec`, `sherpa-onnx-node`, `node:*` builtins, `child_process`, `@anthropic-ai/*`, `@modelcontextprotocol/*`, `react`, `react-dom`, `react-native`, or anything under `apps/*`. Enforced by a lint script (Task 1).
- **Typecheck gate:** After every codemod, run `pnpm --filter @swarm/desktop run typecheck` — it MUST be clean before commit. Codemod misses show up here.
- **node_modules rebuild:** If typecheck breaks on files the task never touched, `rm -rf node_modules apps/desktop/node_modules pnpm-lock.yaml && pnpm install` (memory `workspace-merge-node-modules-rebuild`).
- **One commit per task.** Execute in the dedicated worktree (`worktree-extract-protocol-shared`).

---

## File Structure

**Create packages/protocol/:**
- `package.json` — name `@swarm/protocol`, dep `zod`
- `tsconfig.json` — extends shared base
- `src/index.ts` — barrel re-exporting all types + `service-ipc` + `service-client`

**Create packages/shared/:**
- `package.json` — name `@swarm/shared`, dep `@swarm/protocol` (types only)
- `tsconfig.json`
- `src/index.ts` — barrel re-exporting agents/constants/tokens/system-session

**Create tools/tsconfig/:** `base.json`, `node.json`, `web.json` — shared tsconfig bases.

**Move into packages/protocol/src/ (via git mv):**
- `apps/desktop/src/shared/types/*` (18 type modules + tests) → `packages/protocol/src/types/`
- `apps/desktop/src/shared/types/service-ipc.ts` → `packages/protocol/src/service-ipc.ts`
- `apps/desktop/src/main/service-client.ts` + `service-client.test.ts` + `service-client.mainrpc.test.ts` → `packages/protocol/src/`

**Move into packages/shared/src/ (via git mv):**
- `apps/desktop/src/shared/agents/{delegation,org-tree,model-override,default-prompt}.ts` (+tests) → `packages/shared/src/agents/`
- `apps/desktop/src/shared/constants/{agents,models}.ts` (+tests) → `packages/shared/src/constants/`
- `apps/desktop/src/shared/tokens.ts` (+test), `system-session.ts` → `packages/shared/src/`

**Stay in apps/desktop/src/shared/:** `events.ts`, `logger.ts` (+tests) — main-process internals. `@shared` alias keeps pointing here.

**Modify (alias wiring):** `apps/desktop/tsconfig.node.json`, `apps/desktop/tsconfig.web.json`, `apps/desktop/vitest.config.ts`, `apps/desktop/electron.vite.config.ts` — add `@swarm/protocol` + `@swarm/shared` path/alias entries.

**Create:** `tools/check-boundaries.mjs` — grep-based boundary lint.

---

## Task 1: Package scaffolding + shared tsconfig + alias wiring + boundary lint

**Files:**
- Create: `packages/protocol/{package.json, tsconfig.json, src/index.ts}`, `packages/shared/{package.json, tsconfig.json, src/index.ts}`, `tools/tsconfig/{base,node,web}.json`, `tools/check-boundaries.mjs`
- Modify: `apps/desktop/{tsconfig.node.json, tsconfig.web.json, vitest.config.ts, electron.vite.config.ts, package.json}`
- Test: `pnpm --filter @swarm/desktop run typecheck` still green (no source moved yet, only new empty packages + aliases).

**Interfaces:**
- Produces: two empty workspace packages `@swarm/protocol` and `@swarm/shared` resolvable from desktop via tsconfig paths; boundary lint runnable via `node tools/check-boundaries.mjs`.

- [ ] **Step 1: Shared tsconfig bases**

`tools/tsconfig/base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "ignoreDeprecations": "6.0"
  }
}
```
`tools/tsconfig/node.json`:
```json
{ "extends": "./base.json", "compilerOptions": { "lib": ["ES2022"], "types": ["node"] } }
```
`tools/tsconfig/web.json`:
```json
{ "extends": "./base.json", "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"] } }
```

- [ ] **Step 2: packages/protocol skeleton**

`packages/protocol/package.json`:
```json
{
  "name": "@swarm/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": { "zod": "^4.4.3" }
}
```
`packages/protocol/tsconfig.json`:
```json
{ "extends": "../../tools/tsconfig/node.json", "include": ["src/**/*"] }
```
`packages/protocol/src/index.ts` (empty barrel for now):
```typescript
// Barrel for @swarm/protocol — populated in Task 2.
export {}
```

- [ ] **Step 3: packages/shared skeleton**

`packages/shared/package.json`:
```json
{
  "name": "@swarm/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": { "@swarm/protocol": "workspace:*" }
}
```
`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tools/tsconfig/node.json",
  "include": ["src/**/*"],
  "compilerOptions": {
    "paths": { "@swarm/protocol": ["../protocol/src"], "@swarm/protocol/*": ["../protocol/src/*"] }
  }
}
```
`packages/shared/src/index.ts`:
```typescript
// Barrel for @swarm/shared — populated in Task 3.
export {}
```

- [ ] **Step 4: Wire desktop aliases**

`apps/desktop/package.json` — add to `dependencies`:
```json
    "@swarm/protocol": "workspace:*",
    "@swarm/shared": "workspace:*",
```

`apps/desktop/tsconfig.node.json` — add to `compilerOptions.paths` (keep existing `@shared/*`, `@main/*`, `@worker/*`):
```json
      "@swarm/protocol": ["../../packages/protocol/src"],
      "@swarm/shared": ["../../packages/shared/src"]
```
Do the same in `apps/desktop/tsconfig.web.json` paths (keep existing `@renderer/*`, `@/*`, `@shared/*`).

`apps/desktop/vitest.config.ts` — add to `resolve.alias` (keep existing `@shared`, `@main`, `@service`, `@`):
```typescript
      '@swarm/protocol': resolve(__dirname, '../../packages/protocol/src'),
      '@swarm/shared': resolve(__dirname, '../../packages/shared/src'),
```

`apps/desktop/electron.vite.config.ts` — add `@swarm/protocol` + `@swarm/shared` to BOTH the `main.resolve.alias` and `renderer.resolve.alias` blocks (same `resolve(__dirname, '../../packages/...')` shape).

- [ ] **Step 5: Boundary lint script**

`tools/check-boundaries.mjs`:
```javascript
#!/usr/bin/env node
// Fails if @swarm/protocol or @swarm/shared import anything platform-bound.
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const FORBIDDEN = [
  /^electron/, /^better-sqlite3$/, /^sqlite-vec$/, /^sherpa-onnx-node$/,
  /^node:/, /^child_process$/, /^path$/, /^fs$/, /^os$/,
  /@anthropic-ai\//, /@modelcontextprotocol\//,
  /^react$/, /^react-dom$/, /^react-native$/,
]

const pkgRoot = new URL('../packages/', import.meta.url).pathname
let bad = 0
for (const pkg of ['protocol', 'shared']) {
  let files
  try {
    files = execSync(`git -C "${process.cwd()}" ls-files packages/${pkg}/src`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch { files = [] }
  for (const f of files) {
    if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('@swarm/')) continue
      if (FORBIDDEN.some((re) => re.test(spec))) {
        console.error(`BOUNDARY VIOLATION: ${f} imports "${spec}"`)
        bad++
      }
    }
  }
}
if (bad) { console.error(`\n${bad} boundary violation(s) in @swarm/* packages.`); process.exit(1) }
console.log('Boundary check OK — no forbidden imports in @swarm/* packages.')
```
Add to root `package.json` `scripts`: `"check-boundaries": "node tools/check-boundaries.mjs"`.

- [ ] **Step 6: Install + verify scaffolding**

```bash
pnpm install
pnpm --filter @swarm/desktop run typecheck
node tools/check-boundaries.mjs
```
Expected: install links the two new workspace packages; desktop typecheck green (no source moved yet, empty barrels); boundary check prints "Boundary check OK".

- [ ] **Step 7: Commit**

```bash
git add packages/ tools/ apps/desktop/package.json apps/desktop/tsconfig.node.json apps/desktop/tsconfig.web.json apps/desktop/vitest.config.ts apps/desktop/electron.vite.config.ts package.json pnpm-lock.yaml
git commit -m "build: scaffold @swarm/protocol + @swarm/shared packages (Phase 2 setup)"
```

---

## Task 2: Extract protocol (types + service-ipc + service-client) + rewrite imports

**Files:**
- Move: `apps/desktop/src/shared/types/*` → `packages/protocol/src/types/`; `apps/desktop/src/shared/types/service-ipc.ts` → `packages/protocol/src/service-ipc.ts`; `apps/desktop/src/main/service-client*.ts` → `packages/protocol/src/`
- Modify: `packages/protocol/src/index.ts` (barrel), every desktop file importing `@shared/types/*` or `./service-client`
- Test: `pnpm --filter @swarm/desktop run typecheck && pnpm --filter @swarm/desktop run test && pnpm --filter @swarm/desktop run build`

**Interfaces:**
- Consumes: scaffolding from Task 1 (package + aliases).
- Produces: `@swarm/protocol` exporting all type modules + `ServiceTransport`, `ServiceClient`, `createServiceClient`, `ServiceMethod`, `ServiceRequest`, `ServiceResponse`, `ServiceEvent`.

- [ ] **Step 1: Move types + service-ipc + service-client with git mv**

```bash
mkdir -p packages/protocol/src/types
# Move every .ts under types/ in one shot (18 modules + their tests + service-ipc + test).
git mv apps/desktop/src/shared/types/*.ts packages/protocol/src/types/
git mv apps/desktop/src/main/service-client.ts packages/protocol/src/service-client.ts
git mv apps/desktop/src/main/service-client.test.ts packages/protocol/src/service-client.test.ts
git mv apps/desktop/src/main/service-client.mainrpc.test.ts packages/protocol/src/service-client.mainrpc.test.ts
```
Verify nothing remains: `ls apps/desktop/src/shared/types` should error (dir gone); `ls apps/desktop/src/main/service-client*.ts` should error.

- [ ] **Step 2: Populate the protocol barrel**

Overwrite `packages/protocol/src/index.ts`:
```typescript
// @swarm/protocol — cross-process wire types + RPC client. Zero non-zod runtime deps.

// Type modules
export * from './types/actor'
export * from './types/agent'
export * from './types/bilibili'
export * from './types/budgets'
export * from './types/gmail'
export * from './types/ipc'
export * from './types/mcp'
export * from './types/memory'
export * from './types/model-role'
export * from './types/permission'
export * from './types/provider'
export * from './types/service-ipc'
export * from './types/skill'
export * from './types/task'
export * from './types/tool-toggles'
export * from './types/trending'
export * from './types/ui'
export * from './types/usage'
export * from './types/web-search'

// RPC client + transport (consumed unchanged by desktop, extension, RN)
export * from './service-client'
```
Note: `service-ipc.ts` is exported once via `./types/service-ipc` — keep it there (its existing location after the move is `packages/protocol/src/types/service-ipc.ts`).

- [ ] **Step 3: Fix service-client's own imports**

`packages/protocol/src/service-client.ts` still imports `@shared/types/*`. Rewrite those to relative paths (it lives inside the package now):
```bash
sed -i '' -e "s|from '@shared/types/service-ipc'|from './types/service-ipc'|g" \
          -e "s|from '@shared/types/task'|from './types/task'|g" \
          -e "s|from '@shared/types/ui'|from './types/ui'|g" \
          -e "s|from '@shared/types/agent'|from './types/agent'|g" \
          -e "s|from '@shared/types/budgets'|from './types/budgets'|g" \
          -e "s|from '@shared/types/mcp'|from './types/mcp'|g" \
          -e "s|from '@shared/types/memory'|from './types/memory'|g" \
          -e "s|from '@shared/types/provider'|from './types/provider'|g" \
          -e "s|from '@shared/types/skill'|from './types/skill'|g" \
          -e "s|from '@shared/types/tool-toggles'|from './types/tool-toggles'|g" \
          -e "s|from '@shared/types/web-search'|from './types/web-search'|g" \
          -e "s|from '@shared/logger'|from '../../apps/desktop/src/shared/logger'|g" \
          packages/protocol/src/service-client.ts packages/protocol/src/service-client.test.ts packages/protocol/src/service-client.mainrpc.test.ts
```
**Check `service-client.ts` for `@shared/logger` use first** (`grep -n "@shared/logger\|createLogger" packages/protocol/src/service-client.ts`). If it imports the pino logger, that violates the boundary — the client must not depend on pino. If found, **remove the log call** (or gate it behind an injected `onWarn?` callback) so protocol stays logger-free. Do NOT point protocol at desktop's logger.

- [ ] **Step 4: Bulk-rewrite desktop imports**

```bash
# @shared/types/<anything>  ->  @swarm/protocol   (covers all 18 type modules)
find apps/desktop/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 sed -i '' "s|@shared/types/[^']*|@swarm/protocol|g"

# service-client (both alias and relative)  ->  @swarm/protocol
find apps/desktop/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 sed -i '' -e "s|@main/service-client|@swarm/protocol|g" \
                        -e "s|from '\\./service-client'|from '@swarm/protocol'|g"
```
Expected: 184+ files touched. Verify with `grep -rn "@shared/types" apps/desktop/src` returning nothing, and `grep -rn "service-client" apps/desktop/src/main` showing no bare relative imports of it.

- [ ] **Step 5: Typecheck (catches codemod misses)**

```bash
pnpm --filter @swarm/desktop run typecheck
```
Expected: clean. Any "Cannot find module '@swarm/protocol'" or leftover `@shared/types` reference = a file the sed didn't reach (e.g. `.mts`/`.cts`); fix with scoped `npx biome`/manual edits.

- [ ] **Step 6: Full test + build**

```bash
pnpm --filter @swarm/desktop run test
pnpm --filter @swarm/desktop run build
node tools/check-boundaries.mjs
```
Expected: tests pass (1094+), build green, boundary check OK. If typecheck/build break on untouched files → node_modules residue: `rm -rf node_modules apps/desktop/node_modules pnpm-lock.yaml && pnpm install` (memory `workspace-merge-node-modules-rebuild`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(protocol): extract @swarm/protocol (types + service-ipc + service-client)"
```

---

## Task 3: Extract shared (agents + constants + tokens + system-session) + rewrite imports

**Files:**
- Move: `apps/desktop/src/shared/{agents,constants}/*` + `tokens.ts` + `system-session.ts` (+tests) → `packages/shared/src/`
- Modify: `packages/shared/src/index.ts` (barrel), every desktop file importing `@shared/agents/*`, `@shared/constants/*`, `@shared/tokens`, `@shared/system-session`
- Test: typecheck + test + build + boundary check.

**Interfaces:**
- Consumes: Task 2's `@swarm/protocol` (shared may `export type` re-export some protocol types).
- Produces: `@swarm/shared` exporting `delegation`, `org-tree`, `model-override`, `default-prompt`, `agents`/`models` constants, `estimateTokens`, `SYSTEM_SESSION_ID`.

- [ ] **Step 1: Move pure-logic files with git mv**

```bash
mkdir -p packages/shared/src/agents packages/shared/src/constants
# Move each pure-logic subdir's .ts files in bulk.
git mv apps/desktop/src/shared/agents/*.ts packages/shared/src/agents/
git mv apps/desktop/src/shared/constants/*.ts packages/shared/src/constants/
git mv apps/desktop/src/shared/tokens.ts packages/shared/src/tokens.ts
git mv apps/desktop/src/shared/tokens.test.ts packages/shared/src/tokens.test.ts
git mv apps/desktop/src/shared/system-session.ts packages/shared/src/system-session.ts
rmdir apps/desktop/src/shared/types apps/desktop/src/shared/agents apps/desktop/src/shared/constants 2>/dev/null
```
Verify: `ls apps/desktop/src/shared` should show only `events.ts`, `events.test.ts`, `logger.ts`, `logger.test.ts`.

- [ ] **Step 2: Populate the shared barrel**

Overwrite `packages/shared/src/index.ts`:
```typescript
// @swarm/shared — platform-neutral pure logic. No Node/electron/react deps.

export * from './agents/delegation'
export * from './agents/org-tree'
export * from './agents/model-override'
export * from './agents/default-prompt'
export * from './constants/agents'
export * from './constants/models'
export * from './tokens'
export * from './system-session'
```

- [ ] **Step 3: Fix shared modules' own imports**

The moved modules import `@shared/types/*`. Rewrite to `@swarm/protocol`:
```bash
find packages/shared/src -type f -name '*.ts' -print0 \
  | xargs -0 sed -i '' "s|@shared/types/[^']*|@swarm/protocol|g"
```
Audit for any other `@shared/*` use inside shared: `grep -rn "@shared" packages/shared/src` — should be none after the rewrite.

- [ ] **Step 4: Bulk-rewrite desktop imports**

```bash
find apps/desktop/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 sed -i '' -e "s|@shared/agents/[^']*|@swarm/shared|g" \
                        -e "s|@shared/constants/[^']*|@swarm/shared|g" \
                        -e "s|@shared/tokens'|@swarm/shared'|g" \
                        -e "s|@shared/system-session'|@swarm/shared'|g"
```
Expected: `grep -rn "@shared/agents\|@shared/constants\|@shared/tokens\|@shared/system-session" apps/desktop/src` returns nothing. `@shared/logger` and `@shared/events` imports MUST remain (they stay desktop-internal).

- [ ] **Step 5: Verify + boundary**

```bash
pnpm --filter @swarm/desktop run typecheck
pnpm --filter @swarm/desktop run test
pnpm --filter @swarm/desktop run build
node tools/check-boundaries.mjs
echo "=== desktop @shared alias should only point at events/logger ==="
grep -rn "from '@shared" apps/desktop/src | sed -E "s/.*from '(@shared[^']*)'.*/\1/" | sort -u
```
Expected: typecheck/test/build green; boundary OK; the last grep shows ONLY `@shared/logger` and `@shared/events`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shared): extract @swarm/shared (agents + constants + tokens + system-session)"
```

---

## Task 4: Boundary enforcement + root pipeline verification + cleanup

**Files:**
- Modify: root `package.json` (add `check-boundaries` to a turbo pipeline or the `verify` equivalent), `turbo.json`
- Test: full `turbo run build/test/typecheck` from root + boundary check.

**Interfaces:**
- Produces: the structural guarantee that `@swarm/protocol` and `@swarm/shared` are platform-neutral (lint-enforced), ready for the extension (Phase 5) and RN (Phase 6) to import.

- [ ] **Step 1: Confirm boundary invariant holds**

```bash
node tools/check-boundaries.mjs
```
Expected: "Boundary check OK". If any violation, the offending import must be removed (protocol/shared cannot depend on Node/electron/react/native). Typical offender: a shared module using `node:crypto` or `Date.now()` — refactor to take the value as a parameter instead.

- [ ] **Step 2: Wire boundary check into turbo**

`turbo.json` — add a `check-boundaries` task (and make `build` depend on it):
```json
    "check-boundaries": {
      "dependsOn": ["^build"],
      "outputs": []
    },
```
Root `package.json` `scripts` — add: `"check-boundaries": "turbo run check-boundaries"`. (turbo will run it; since the script is at the repo root not in a workspace package, alternatively keep it as a direct `node tools/check-boundaries.mjs` in the root `verify`-style script — pick whichever matches existing convention.)

- [ ] **Step 3: Full root pipeline**

```bash
pnpm typecheck
pnpm test
pnpm build
```
Expected: turbo runs `@swarm/desktop` for each, all green. (The two packages have no build/test scripts yet — they're source-consumed — so turbo only runs desktop.)

- [ ] **Step 4: Smoke-test the app**

```bash
SWARM_USER_DATA_DIR=/tmp/swarm-plan2 node .claude/skills/run-desktop/driver.mjs
# in the REPL: launch  →  ss main  →  quit
```
Expected: window opens and renders (Phase 1 driver is monorepo-aware). Confirms desktop main/renderer/service still wire up after the extraction.

- [ ] **Step 5: Commit**

```bash
git add turbo.json package.json
git commit -m "build: enforce @swarm/* package boundaries via lint (Phase 2+3 closeout)"
```

---

## Acceptance

Plan 2 is complete when **all** hold:

1. `packages/protocol` exists, exports every former `src/shared/types/*` plus `ServiceClient`/`ServiceTransport`/`createServiceClient`/`service-ipc`, and its only runtime dep is `zod`.
2. `packages/shared` exists, exports `agents/*`/`constants/*`/`tokens`/`system-session`, depends only on `@swarm/protocol` (types).
3. `apps/desktop/src/shared/` contains ONLY `events.ts` + `logger.ts` (+tests); the `@shared` alias still resolves them.
4. No desktop file imports `@shared/types/*`, `@shared/agents/*`, `@shared/constants/*`, `@shared/tokens`, or `@shared/system-session` (grep-clean).
5. `node tools/check-boundaries.mjs` passes — `@swarm/*` import nothing platform-bound.
6. `turbo run typecheck/test/build` green from root; app launches and renders.
7. Four new commits on the worktree branch, one per task.

After Plan 2 lands, proceed to Plan 3 (desktop WebSocket host, Phase 4) — the first real cross-platform consumer of `@swarm/protocol`.
