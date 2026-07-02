# Shared shadcn UI Package (`@swarm/ui`) — Design

**Date:** 2026-07-02
**Status:** Design (pending user review)
**Scope:** `apps/desktop`, `apps/extension`, new `packages/ui`

## 1. Goal

1. Update shadcn components via the user-supplied preset:
   `bunx --bun shadcn@latest apply --preset b1abxEJN2`.
2. Make the resulting components shareable between `apps/desktop` (Electron +
   Vite + Tailwind v4) and `apps/extension` (WXT + React), instead of living
   only inside the desktop renderer.

## 2. Current state (verified)

- **Desktop renderer** (`apps/desktop/src/renderer`):
  - Tailwind v4 via `@tailwindcss/vite` (CSS-first, no `tailwind.config`).
  - Has shadcn `components.json`: `style: base-nova`, `baseColor: neutral`,
    `cssVariables: true`, `iconLibrary: lucide`, `rsc: false`, aliases
    `@/components`, `@/lib/utils`, `@/components/ui`, …
  - `@/` → `src/renderer/src` (vite alias + `tsconfig.web.json` paths).
  - ~60 files in `components/ui/` — a mix of pure shadcn primitives and
    domain viewers (`pdf-viewer`, `csv-viewer`, `docx-viewer`, …).
  - Design tokens live in `src/styles/globals.css` (`@theme inline`, `:root`,
    `.dark`); font cascade + a streamdown `@source` directive are also there.
  - React 19 + React Compiler.
- **Extension** (`apps/extension`, WXT):
  - React 19, `@wxt-dev/module-react`. **No Tailwind, no shadcn, no
    `components.json`.** Entrypoints: `popup`, `options`, `background`; UI is
    raw React (`Popup.tsx`, `Options.tsx`).
  - `@swarm/protocol` consumed from source via vite alias.
- **`@swarm/shared`** is platform-agnostic by rule: `tools/check-boundaries.mjs`
  forbids it from importing `react`/`react-dom`/`electron`/node builtins.
  → **Shared React UI cannot live in `@swarm/shared`.** A new package is
  required.
- Both apps already consume workspace packages from source via the pattern
  `'<name>': resolve('../../packages/<pkg>/src')` in their vite config and
  `tsconfig` `paths`. The new package mirrors this.

## 3. Approach chosen — Option 1 (minimal)

Create `@swarm/ui` as the single home for shadcn; apply the preset there; wire
both apps to consume it. **Desktop's existing ~60 `components/ui` files are
left untouched** (no import rewrites). Larger migrations are explicit
follow-ups (§9).

Rationale: matches CLAUDE.md §2 (Simplicity) / §3 (Surgical Changes). The
request is "update shadcn + make components shareable" — Option 1 does exactly
that with the smallest, lowest-risk diff. Re-export shims and full migration
are available later without rework.

### Rejected alternatives
- **Option 2 (re-export shim):** desktop's `@/components/ui/<x>` files become
  `export { X } from '@swarm/ui'`. Gives single-source-of-truth for primitives
  with zero import rewrites, but adds ~N shim files now. Deferred.
- **Option 3 (full migration):** physically move all desktop `components/ui`
  into `@swarm/ui` and rewrite every `@/components/ui` import across the
  renderer. Highest effort/risk (hundreds of import sites). Deferred.

## 4. Architecture

### 4.1 New package `packages/ui` (`@swarm/ui`)

Source-only workspace package (no build step), mirroring `@swarm/shared`:

```
packages/ui/
  package.json          # name @swarm/ui, private, main/types → src/index.ts
  tsconfig.json         # extends ../../tools/tsconfig/base.json, jsx react-jsx
  components.json       # shadcn config (aliases resolve inside ./src)
  src/
    index.ts            # barrel: re-exports all ui components + cn
    lib/utils.ts        # cn() = twMerge(clsx(...))
    styles/tokens.css   # portable token block (see 4.2)
    components/ui/*     # populated by `shadcn apply` (the preset)
  vite.config.ts       # permanent stub — shadcn framework-detection marker only
                       # (no build step; apply/add exit 1 "could not detect a
                       # supported framework" without a vite.config.*)
```

**`package.json`** (key fields):
- `name: "@swarm/ui"`, `version: "0.0.0"`, `private: true`, `type: "module"`.
- `main` / `types` → `"./src/index.ts"`.
- `scripts`: `typecheck: "tsc --noEmit"`, `test: "vitest run"` (parity with
  other workspace packages; tests optional initially).
- `peerDependencies`: `react`, `react-dom` (resolved from the consuming app).
- `dependencies`: `clsx`, `tailwind-merge`, `class-variance-authority`,
  `lucide-react`, plus whatever Radix primitives `shadcn add/apply` introduces
  (the CLI writes these into `dependencies` automatically).

**`components.json`** (mirrors desktop's, but aliases resolve inside the
package's own `src`):
```jsonc
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/tokens.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```
`@/*` resolves to `./src/*` (declared in the package's own `tsconfig` paths so
the shadcn CLI's emitted imports typecheck inside the package).

**`src/lib/utils.ts`**: identical to desktop's current `cn`.

### 4.2 Token CSS (`src/styles/tokens.css`)

The **portable** subset of desktop's `globals.css`: the `@theme inline` block,
`:root` and `.dark` variable definitions, `@custom-variant dark`, and the
`@import "tailwindcss"; @import "tw-animate-css";` prologue. **Excluded** are
app-specific bits (streamdown `@source`, the macOS font cascade comment is
fine to keep). Both apps import this so tokens are single-source.

### 4.3 Applying the preset

```
cd packages/ui
bunx --bun shadcn@latest apply --preset b1abxEJN2
```
Run **inside the package** so the CLI reads the local `components.json`. The
preset is expected to populate `src/components/ui/*` and may rewrite
`components.json` / `tokens.css`. **Review the diff before committing**:
confirm aliases survived, tokens are intact, and the component set is sane.
(Exact preset contents are unknown until applied — this is the one step whose
output we inspect rather than predict.)

## 5. Wiring

### 5.1 Desktop (`apps/desktop`)
- `electron.vite.config.ts` → renderer `resolve.alias`: add
  `'@swarm/ui': resolve('../../packages/ui/src')`.
- `tsconfig.web.json`:
  - `paths`: `"@swarm/ui": ["../../packages/ui/src"]`,
    `"@swarm/ui/*": ["../../packages/ui/src/*"]`.
  - `include`: `"../../packages/ui/src/**/*"` (+ test excludes mirroring
    protocol/shared).
- `apps/desktop/package.json`: `"@swarm/ui": "workspace:*"`.
- `src/styles/globals.css`: add an `@source` directive pointing at the
  `@swarm/ui` source so Tailwind v4 generates classes used inside shared
  components. **Tailwind v4 does not auto-scan outside the CSS file's
  subtree**, so without this, a `@swarm/ui` component imported into the
  renderer renders unstyled. The exact relative path is verified at impl by
  resolving the `node_modules/@swarm/ui` symlink from the CSS file's directory
  (mirror the existing streamdown `@source` line — same mechanism). Desktop
  keeps its own token block for now (it already defines the same palette);
  importing package tokens is a §9 follow-up.

### 5.2 Extension (`apps/extension`)
- `apps/extension/package.json`: add `"@swarm/ui": "workspace:*"` and dev deps
  `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css`.
- `wxt.config.ts`: add `@tailwindcss/vite()` to `vite.plugins` and alias
  `'@swarm/ui': resolve(__dirname, '../../packages/ui/src')`.
- `tsconfig.json`: `paths` `"@swarm/ui": ["../../packages/ui/src"]`,
  `"@swarm/ui/*": ["../../packages/ui/src/*"]`; `include` the package src.
- New `entrypoints/popup/globals.css` and `entrypoints/options/globals.css`:
  ```css
  @import "tailwindcss";
  @import "tw-animate-css";
  @import "@swarm/ui/src/styles/tokens.css";
  @source "<resolved path to @swarm/ui src>";
  ```
  Import each in the matching `main.tsx`.
  - **Resolution note:** the JS import alias (`@swarm/ui` → `packages/ui/src`)
    and CSS bare-specifier `@import` resolve via **different mechanisms**. CSS
    `@import "@swarm/ui/…"` resolves through the `node_modules/@swarm/ui`
    workspace symlink (→ `packages/ui/…`), independent of the vite alias. The
    `@source` path is resolved relative to the CSS file — verify both at impl
    and fall back to an explicit relative path if the bare form does not
    resolve.
- Smoke test: render a shared component (e.g. `<Button>`) in `Popup.tsx` to
  confirm Tailwind + tokens resolve inside the MV popup.

> Radix/clsx/etc. resolution: `@swarm/ui` declares its deps; with
> `shamefullyHoist: true` pnpm hoists them so the extension's bundler resolves
> them through the symlinked package. If any fail to resolve at build time,
> add them to the extension's deps (verification step, §7).

## 6. Boundary checker

Extend `tools/check-boundaries.mjs` to also scan `packages/ui/src`. The
forbidden list for `ui` drops `react`/`react-dom` (UI is allowed to use React)
but keeps `electron`, `better-sqlite3`, `sqlite-vec`, `sherpa-onnx-node`,
`node:`, `child_process`, `path`, `fs`, `os`, `react-native`, etc. — keeping
`@swarm/ui` platform-agnostic (web-only, Electron-free). Concretely: add a
second `FORBIDDEN_UI` list and loop `ui` through it.

## 7. Verification

1. `node tools/check-boundaries.mjs` → `Boundary check OK`.
2. `pnpm install` → relinks `@swarm/ui` into both apps.
3. `pnpm typecheck` (turbo; `@swarm/ui` has `typecheck` script) → green.
4. `pnpm check` (biome, scoped to new files — use
   `npx biome check --write <files>`, see memory
   `reference_biome_check_hardcodes_dot`).
5. Manual:
   - `run-desktop`: render a `@swarm/ui` component somewhere visible (e.g. a
     `Button` in a settings panel) → styled correctly, no missing classes.
   - Extension: load popup → shared `Button` renders styled.
   - Screenshot both for the record.
6. If a shared component's classes look unstyled → the `@source` path is
   wrong; fix and rebuild.

## 8. Risks / notes

- **Preset surprises:** may change style/baseColor or rewrite aliases/tokens.
  Mitigation: inspect diff, restore aliases/portable tokens, then commit.
- **Tailwind content detection across packages:** requires explicit `@source`
  in each app's CSS (handled in §5).
- **Radix dep resolution in extension:** hoisting should cover it; verify, add
  to extension deps if not.
- **Token drift:** desktop keeps its own token block in minimal scope; the
  package's `tokens.css` is the canonical source going forward. Single-sourcing
  desktop's globals is a §9 follow-up to avoid drift.

## 9. Explicitly out of scope (follow-ups)

- `apps/mobile` (Expo / React Native — shadcn web does not apply).
- **Option 2** — desktop `@/components/ui/<primitive>` re-export shims from
  `@swarm/ui` (single-source without import rewrites).
- **Option 3** — full migration of desktop's ~60 `components/ui` files into
  `@swarm/ui` with import rewrites.
- Desktop `globals.css` → import `@swarm/ui/src/styles/tokens.css` to make
  tokens single-source.
- Retiring desktop's local `components.json` once primitives are sourced from
  the package.

These are offered as next steps after the minimal package lands; picking none
keeps the package purely additive.
