# Monorepo Skeleton + Desktop Move (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the single SwarmAgents Electron package into a pnpm/turborepo monorepo by moving the entire existing project verbatim into `apps/desktop/`, with **zero behavioral regression** on desktop. No code inside `src/` is touched; no `@swarm/protocol` or `@swarm/shared` extraction yet (those are Phase 2/3).

**Architecture:** The existing `src/`, every config file (`electron.vite.config.ts`, `electron-builder.yml`, `tsconfig.*`, `vitest.config.ts`), and the resource/script directories all use **paths relative to the package root** (`src/...`, `build/`, `resources/`, `__dirname`). Moving them into `apps/desktop/` preserves every relative reference, so the move is mechanical `git mv` plus two package.json edits. The root becomes a slim workspace orchestrator (turbo). Three tasks: (1) stand up workspace scaffolding without disturbing the current build; (2) relocate desktop; (3) wire turbo and verify from the root.

**Tech Stack:** pnpm workspaces, turborepo, electron-vite, electron-builder, vitest, biome, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-01-multiplatform-structure-design.md` (§10 Phase 1).

## Global Constraints

- **Language:** Code comments and commit messages in English. Conversation in Chinese.
- **History:** Move files with `git mv` (never copy+delete) so history is preserved.
- **Tests:** Run with `npm test` (the project runs vitest through Electron's node — memory `project_run_tests_via_electron_node`). NEVER bare `npx vitest`. NEVER `pnpm rebuild better-sqlite3` (breaks the app's native ABI); the `postinstall` (`install-electron && electron-builder install-app-deps`) is what rebuilds native modules correctly — keep it.
- **Format:** Scope a format with `npx biome check --write <file>` (NOT `pnpm check`/`pnpm format`, which reformat the whole repo — memory `reference_biome_check_hardcodes_dot`).
- **Electron binary:** If `pnpm dev` reports "Electron uninstall", fix with `pnpm exec install-electron` (Electron ≥42 dropped its postinstall — memory `project_electron_binary_install`). The npmmirror mirrors in root `.npmrc` must stay at the repo root (they govern Electron/builder binary downloads).
- **Regression bar:** Every task ends with desktop `typecheck` + `test` + `build` green AND the app launches. A task is not done until the previous behavior is reproduced exactly.
- **Worktree:** Execute in the dedicated worktree (branch `worktree-multiplatform-structure`). Do not run on `develop` directly.
- **One commit per task.** Each task is a single reviewable commit.

---

## File Structure

**Move into `apps/desktop/` (via `git mv`):**
- `src/` → `apps/desktop/src/`
- `electron.vite.config.ts`, `electron-builder.yml`, `dev-app-update.yml` → `apps/desktop/`
- `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json` → `apps/desktop/`
- `vitest.config.ts` → `apps/desktop/`
- `build/`, `resources/`, `scripts/`, `patches/` → `apps/desktop/`

**Create:**
- `apps/`, `packages/`, `tools/` directories (with README placeholders so git tracks them).
- `apps/desktop/package.json` — receives the current root package.json contents, `name` → `@swarm/desktop`.
- `turbo.json` (repo root) — task pipeline.
- Root `package.json` — slimmed to workspace root (turbo + biome + typescript devDeps, turbo scripts).

**Stay at repo root (do NOT move):** `.npmrc`, `biome.json`, `.gitignore`, `.editorconfig`, `CLAUDE.md`, `AGENTS.md` (symlink), `README.md`, `docs/`, `references/`, `.claude/`, `.codegraph/`, `.vscode/`, `.cursor/`, `.agents/`, `.claire/`, `.tanstack/`, `.mcp.json`, `.superpowers/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

**Regenerate (delete, not move — they are build artifacts):** `tsconfig.node.tsbuildinfo`, `tsconfig.web.tsbuildinfo`, `out/`, `dist/`.

**Why nothing inside `src/` changes:** every config resolves paths relatively. `electron.vite.config.ts` uses `resolve('src/main/index.ts')` (relative to its own location), `tsconfig.*.json` use `include: ["src/..."]` + `paths: { "@shared/*": ["src/shared/*"] }`, and `vitest.config.ts` uses `resolve(__dirname, 'src/shared')`. After the move these all resolve against `apps/desktop/`, which is exactly where `src/` now lives.

---

## Task 1: Stand up workspace scaffolding (non-disruptive)

**Files:**
- Create: `apps/`, `packages/`, `tools/` (+ README placeholders)
- Modify: `pnpm-workspace.yaml`, root `package.json` (add turbo devDep only)
- Test: existing `npm test` still passes; `pnpm dev` still launches.

**Interfaces:**
- Consumes: the current single-package layout (desktop still at repo root).
- Produces: a valid pnpm workspace declaration + turbo installed; desktop behavior unchanged because nothing has moved yet.

This task is deliberately the smallest safe step: it adds the workspace machinery without relocating anything, so if it breaks, the blast radius is contained to install config.

- [ ] **Step 1: Create the workspace directories with git-trackable placeholders**

Run:
```bash
mkdir -p apps packages tools
cat > packages/README.md <<'EOF'
# packages

Shared workspace packages. Phase 2 adds `@swarm/protocol`; Phase 3 adds `@swarm/shared`.
EOF
cat > tools/README.md <<'EOF'
# tools

Shared repo-level tooling configs (tsconfig bases, etc.). Populated in later phases.
EOF
```
Expected: three directories exist; `packages/README.md` and `tools/README.md` created. `apps/` is intentionally empty for now (git does not track empty dirs, which is fine — it fills in Task 2).

- [ ] **Step 2: Declare the workspace in `pnpm-workspace.yaml`**

The current file only has `onlyBuiltDependencies` / `allowBuilds` / `shamefullyHoist`. Prepend a `packages:` field and keep everything else byte-for-byte. Resulting file:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'tools/*'

onlyBuiltDependencies:
  - electron
  - electron-winstaller
  - esbuild
shamefullyHoist: true
allowBuilds:
  '@google/genai': false
  better-sqlite3: true
  electron: true
  electron-winstaller: true
  esbuild: true
  protobufjs: false
```

- [ ] **Step 3: Install turbo as a root devDep**

Run:
```bash
pnpm add -Dw turbo
```
Expected: `turbo` appears in root `package.json` `devDependencies`; `pnpm-lock.yaml` updated. No scripts changed yet.

- [ ] **Step 4: Verify nothing regressed (desktop still at root)**

Run:
```bash
pnpm install
npm test
```
Expected: `pnpm install` succeeds (workspace declared, but the root package still owns all deps); the full vitest suite passes exactly as before.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml packages/ tools/
git commit -m "build: declare pnpm workspace + install turbo (Phase 1 scaffolding)"
```

---

## Task 2: Relocate desktop into `apps/desktop/`

**Files:**
- Move (git mv): `src/`, all configs, `build/`, `resources/`, `scripts/`, `patches/` → `apps/desktop/`
- Create: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml` (artifactName `${name}` → `${productName}`), root `package.json` (slim to workspace root)
- Delete: `tsconfig.node.tsbuildinfo`, `tsconfig.web.tsbuildinfo` (regenerated)
- Test: desktop `typecheck` + `test` + `build` green; `pnpm dev` launches.

**Interfaces:**
- Consumes: the workspace from Task 1.
- Produces: `apps/desktop` — a self-contained Electron workspace package that builds and runs identically to the pre-move repo. Later phases add `@swarm/protocol` / `@swarm/shared` as its dependencies.

- [ ] **Step 1: Create the destination and move source + configs with `git mv`**

Run:
```bash
mkdir -p apps/desktop
git mv src apps/desktop/src
git mv electron.vite.config.ts apps/desktop/
git mv electron-builder.yml apps/desktop/
git mv dev-app-update.yml apps/desktop/
git mv tsconfig.json apps/desktop/
git mv tsconfig.node.json apps/desktop/
git mv tsconfig.web.json apps/desktop/
git mv vitest.config.ts apps/desktop/
```
Expected: each `git mv` reports success; `git status` shows the moves as renames.

- [ ] **Step 2: Move resource and script directories with `git mv`**

Run:
```bash
git mv build apps/desktop/build
git mv resources apps/desktop/resources
git mv scripts apps/desktop/scripts
git mv patches apps/desktop/patches
```
Expected: four directories relocated.

- [ ] **Step 3: Generate `apps/desktop/package.json` from the current root package.json**

The desktop package is the current root package.json with one change: `name` becomes `@swarm/desktop`. Generate it programmatically to avoid hand-copying 100+ dependencies:

```bash
node -e "
const fs = require('fs');
const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const desktop = { ...root, name: '@swarm/desktop' };
fs.writeFileSync('apps/desktop/package.json', JSON.stringify(desktop, null, 2) + '\n');
"
```
Expected: `apps/desktop/package.json` created; diff it against the old root `package.json` — the ONLY difference should be the `name` field. Verify:
```bash
diff <(node -e "console.log(JSON.stringify(require('./package.json'),null,2))") \
     <(node -e "console.log(JSON.stringify(require('./apps/desktop/package.json'),null,2))")
```
Expected output: a single hunk changing `"name": "swarm-agents"` → `"name": "@swarm/desktop"`.

- [ ] **Step 4: Keep installer artifact names stable**

`apps/desktop/electron-builder.yml` uses `${name}` in `artifactName`. With the new package name `@swarm/desktop`, `${name}` would produce broken Windows filenames (contains `/`). Switch those to `${productName}` (productName is `SwarmAgents`, unchanged) so installer artifacts keep their names.

Edit `apps/desktop/electron-builder.yml`:

```yaml
nsis:
  artifactName: ${productName}-${version}-setup.${ext}
```
```yaml
dmg:
  artifactName: ${productName}-${version}.${ext}
```
```yaml
appImage:
  artifactName: ${productName}-${version}.${ext}
```

(`${name}` does not appear anywhere else in the file — verify with `grep '\${name}' apps/desktop/electron-builder.yml` returning nothing.)

- [ ] **Step 5: Slim the root `package.json` to a workspace root**

Transform the root `package.json` in place (do NOT hand-overwrite — it would drop the `turbo` version installed in Task 1). Keep `name`/`version`, set `private: true`, replace `scripts` with turbo entry points, and move ALL `dependencies`/`devDependencies` out (they live in `apps/desktop` now). Preserve the already-installed turbo version by reading it back:

```bash
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const out = {
  name: p.name,
  version: p.version,
  private: true,
  description: 'SwarmAgents monorepo: desktop host + browser extension + React Native client.',
  scripts: {
    build: 'turbo run build',
    test: 'turbo run test',
    typecheck: 'turbo run typecheck',
    lint: 'turbo run lint',
    dev: 'turbo run dev',
    format: 'biome format --write .',
    check: 'biome check --write .'
  },
  devDependencies: { turbo: p.devDependencies && p.devDependencies.turbo }
};
fs.writeFileSync('package.json', JSON.stringify(out, null, 2) + '\n');
"
```
Expected: root `package.json` now contains only `name`, `version`, `private`, `description`, `scripts`, and `devDependencies.turbo`. Verify the runtime deps moved with the desktop package in Step 3:
```bash
node -e "const d=require('./apps/desktop/package.json'); console.log('desktop deps:', Object.keys(d.dependencies||{}).length, 'devDeps:', Object.keys(d.devDependencies||{}).length)"
```
Expected: non-zero counts for both (the ~120 deps/devDeps relocated into `apps/desktop/package.json`).

Then add the workspace-wide CLI devDeps at the root so `biome`/`tsc`/`tsx` work from anywhere:
```bash
pnpm add -Dw @biomejs/biome typescript tsx
```
Expected: root `devDependencies` now lists `turbo`, `@biomejs/biome`, `typescript`, `tsx` (versions resolved by pnpm from the lockfile).

- [ ] **Step 6: Remove stale build artifacts that reference old paths**

Run:
```bash
rm -f tsconfig.node.tsbuildinfo tsconfig.web.tsbuildinfo
rm -rf out dist
```
Expected: stale incremental-build files and old output dirs gone. Confirm they are not tracked (if `git status` shows them as deleted, that is fine — stage the deletion in Step 10).

- [ ] **Step 7: Re-resolve the workspace**

Run:
```bash
pnpm install
```
Expected: pnpm recognizes `apps/desktop` as a workspace package, hoists its dependencies to the root `node_modules` (`shamefullyHoist: true`), and symlinks them into `apps/desktop/node_modules`. No install errors. If `better-sqlite3`/`electron` build prompts appear, they are expected (the workspace rebuilds native deps via desktop's `postinstall`).

Then run desktop's postinstall explicitly to rebuild native modules against Electron's ABI:
```bash
pnpm --filter @swarm/desktop run postinstall
```
Expected: `install-electron` downloads the Electron binary (via the root `.npmrc` npmmirror); `electron-builder install-app-deps` rebuilds native modules. If it reports "Electron uninstall", run `pnpm exec install-electron` (memory `project_electron_binary_install`).

- [ ] **Step 8: Verify desktop typecheck, test, build**

Run from repo root:
```bash
pnpm --filter @swarm/desktop run typecheck
pnpm --filter @swarm/desktop run test
pnpm --filter @swarm/desktop run build
```
Expected:
- `typecheck`: both `typecheck:node` and `typecheck:web` pass, no errors.
- `test`: full vitest suite passes (run through Electron's node).
- `build`: `electron-vite build` produces `apps/desktop/out/main/index.js` and `apps/desktop/out/main/service.js`.

If `typecheck` cannot find `tsconfig.node.json`, confirm Task 2 Step 1 moved it into `apps/desktop/`.

- [ ] **Step 9: Smoke-test the app launches**

Run (use the project's `run-desktop` skill, or manually):
```bash
pnpm --filter @swarm/desktop run dev
```
Expected: the SwarmAgents window opens, renders the existing UI, and a quick manual goal submission dispatches a task (verifies main + service sidecar + renderer all wire up at the new path). Stop the dev server once confirmed.

- [ ] **Step 10: Commit**

```bash
git add -A
git status   # confirm: renames under apps/desktop/, slimmed root package.json, deleted tsbuildinfo
git commit -m "build: relocate Electron app into apps/desktop (Phase 1 move)"
```

---

## Task 3: Wire turbo pipelines and verify from the root

**Files:**
- Create: `turbo.json`
- Modify: root `package.json` (turbo scripts already added in Task 2 Step 5 — confirm), `apps/desktop/package.json` (ensure `build`/`test`/`typecheck`/`lint`/`dev` scripts exist)
- Test: `pnpm build` / `pnpm test` / `pnpm typecheck` from repo root all green.

**Interfaces:**
- Consumes: `apps/desktop` from Task 2 (the only workspace package with tasks so far).
- Produces: a root-level `pnpm <task>` entry point that turbo fans out to every workspace. Phase 2+ packages drop into this graph with no further root changes.

- [ ] **Step 1: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["apps/desktop/out/**", "apps/desktop/dist/**", "dist/**", "out/**"]
    },
    "test": {},
    "typecheck": {},
    "lint": {},
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```
(`^build` makes package `build`s run before app `build`s once `@swarm/protocol`/`@swarm/shared` exist. `dev` is persistent and never cached.)

- [ ] **Step 2: Confirm `apps/desktop/package.json` has the scripts turbo invokes**

Check that `apps/desktop/package.json` `scripts` includes `build`, `test`, `typecheck`, `lint`, `dev` (these came over verbatim from the original root package.json in Task 2 Step 3). If any is missing, add it:
- `build`: `"npm run typecheck && electron-vite build"`
- `test`: `"cross-env ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run"`
- `typecheck`: `"npm run typecheck:node && npm run typecheck:web"`
- `lint`: `"biome lint ."`
- `dev`: `"electron-vite dev"`

(These are copied from the original root scripts — do not invent new ones.)

- [ ] **Step 3: Verify the full root-driven pipeline**

Run from repo root:
```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
Expected: turbo resolves `@swarm/desktop` for each task and runs the same commands that passed in Task 2 Step 8. All green. `apps/desktop/out/main/{index,service}.js` produced.

- [ ] **Step 4: Confirm `pnpm dev` still launches via turbo**

Run:
```bash
pnpm dev
```
Expected: turbo runs `@swarm/desktop`'s `dev` (persistent); the app window opens. Stop it once confirmed.

- [ ] **Step 5: Commit**

```bash
git add turbo.json package.json apps/desktop/package.json
git commit -m "build: wire turbo task pipelines for the monorepo (Phase 1)"
```

---

## Phase 1 Acceptance

Phase 1 is complete when **all** hold:

1. Repo layout is `apps/desktop/` (full Electron project) + empty `packages/` + empty `tools/` + slim root.
2. `git log --follow apps/desktop/src/main/index.ts` shows pre-move history (git mv preserved it).
3. From repo root: `pnpm typecheck`, `pnpm test`, `pnpm build` all green.
4. `pnpm dev` launches the app and a goal submission runs end-to-end.
5. `apps/desktop/electron-builder.yml` references `${productName}` (not `${name}`) in artifact names.
6. Root `.npmrc` (Electron/builder mirrors) and `biome.json` remain at the repo root.
7. Exactly three new commits on the worktree branch, one per task.

After Phase 1 lands, proceed to Plan 2 (extract `@swarm/protocol` + `@swarm/shared`, Phase 2+3 of the spec).
