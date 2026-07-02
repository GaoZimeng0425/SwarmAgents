# Shared shadcn UI Package (`@swarm/ui`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize shadcn components in a new `@swarm/ui` workspace package, apply the user's `b1abxEJN2` preset there, and consume it from both `apps/desktop` and `apps/extension`.

**Architecture:** A new source-only workspace package `packages/ui` (`@swarm/ui`) holds the shadcn `components.json`, the `cn` util, the portable design-token CSS, and the components the preset pulls in. Both apps consume it from source via the existing `vite resolve.alias` + `tsconfig paths` pattern (same as `@swarm/protocol`/`@swarm/shared`), and point Tailwind v4 at it with `@source`. The extension gains Tailwind v4. The boundary checker gains an `@swarm/ui` rule (React allowed, Electron/native forbidden).

**Tech Stack:** pnpm 11 workspaces, turbo, Tailwind v4 (`@tailwindcss/vite`, CSS-first), shadcn (`base-nova`/neutral/lucide), React 19, Vitest, WXT (extension), electron-vite (desktop).

## Global Constraints

- **Option 1 / minimal scope:** desktop's existing ~60 `components/ui` files are NOT migrated, renamed, or rewritten. `@swarm/ui` is purely additive. (Re-export shim / full migration are documented follow-ups in the spec, §9.)
- **`@swarm/ui` must stay platform-agnostic:** React/web libs allowed; `electron`, `better-sqlite3`, `sqlite-vec`, `sherpa-onnx-node`, node builtins (`node:`, `child_process`, `path`, `fs`, `os`), `react-native`, `@anthropic-ai/*`, `@modelcontextprotocol/*` forbidden. Enforced by `tools/check-boundaries.mjs`.
- **Source-only package:** no build step. `main`/`types` → `./src/index.ts`. Consumed from source via vite alias + tsconfig paths (mirror `@swarm/shared`).
- **shadcn framework marker:** `packages/ui/vite.config.ts` (a permanent `export default {}` stub) exists solely so the shadcn CLI's framework detector recognizes the package — without it, `apply`/`add` exit 1 with "could not detect a supported framework". It is NOT a build config: no `build` script, outside the tsconfig `include`, never built by turbo.
- **Design direction = `base-sera` (user-approved, supersedes Task 1's `base-nova`):** the preset `b1abxEJN2` rethemes `@swarm/ui` to `base-sera` / `zinc` / Montserrat / **Base UI** (`@base-ui/react`, NOT Radix) and is **theme-only** (no components). Keep the preset's `components.json` + `tokens.css` + deps; add components via `shadcn add` (starter set: `button card input label sonner`). The preset's `tokens.css` is the canonical theme (do NOT restore Task 1's native block). Use `npx`, not `bunx --bun` (Bun 1.3.14 lacks `node:sqlite`, which the CLI uses during dep-install). Consequence: the extension becomes base-sera-themed; desktop keeps its own native `globals.css` — divergence accepted by the user.
- **Versions (copy verbatim):** `tailwindcss@^4.3.2`, `@tailwindcss/vite@^4.3.2`, `tw-animate-css@^1.4.0`, `clsx@^2.1.1`, `tailwind-merge@^3.6.0`, `class-variance-authority@^0.7.1`, `lucide-react@^1.22.0`, `@types/react@19.2.17`, `@types/react-dom@19.2.3`, `vitest@^4.1.9`, `typescript@^6.0.3`.
- **Test runner for `@swarm/ui`:** plain `vitest run` (no Electron — `cn` is pure TS). Desktop's electron-node test rule does NOT apply to this package.
- **Commit messages & code comments in English.** Conversation in Chinese. Biome is the formatter (`npx biome check --write <file>` for scoped formatting — `pnpm check` reformats the whole repo).
- **Worktree:** implement in an isolated worktree off `develop` (CLAUDE.md §6). Created at execution time via superpowers:using-git-worktrees.

---

## File Structure

**New package `packages/ui/`:**
- `package.json` — `@swarm/ui`, source-only, scripts `typecheck` + `test`, peer React 19.
- `tsconfig.json` — extends `tools/tsconfig/base.json`, adds JSX + DOM lib + `@/*` path.
- `components.json` — shadcn config; aliases resolve inside `./src`.
- `src/lib/utils.ts` — `cn()` (clsx + tailwind-merge), copied verbatim from desktop.
- `src/lib/utils.test.ts` — smoke test for `cn` + package test harness.
- `src/styles/tokens.css` — portable Tailwind v4 token block (`@theme inline`, `:root`, `.dark`, base layer). The single source of truth for design tokens.
- `src/components/ui/*` — populated by the preset (Task 2).
- `src/index.ts` — barrel re-exporting `cn` + every ui component.
- `vite.config.ts` — permanent shadcn framework-detection marker only (no build step; Task 2).

**Modified:**
- `tools/check-boundaries.mjs` — per-package rules; add `ui`.
- `apps/desktop/electron.vite.config.ts` — renderer alias `@swarm/ui`.
- `apps/desktop/tsconfig.web.json` — `@swarm/ui` paths + include.
- `apps/desktop/package.json` — `@swarm/ui` dep.
- `apps/desktop/src/renderer/src/styles/globals.css` — `@source` for the package.
- `apps/extension/package.json` — tailwind deps + `@swarm/ui` dep.
- `apps/extension/wxt.config.ts` — `@tailwindcss/vite` plugin + `@swarm/ui` alias.
- `apps/extension/tsconfig.json` — `@swarm/ui` paths + include.
- `apps/extension/entrypoints/popup/globals.css` (new) + `popup/main.tsx` — import it.
- `apps/extension/entrypoints/options/globals.css` (new) + `options/main.tsx` — import it.
- `apps/extension/entrypoints/popup/Popup.tsx` — replace the raw `<button>` with a `@swarm/ui` `Button` (real smoke usage).

---

### Task 1: Scaffold the `@swarm/ui` package

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/components.json`, `packages/ui/src/lib/utils.ts`, `packages/ui/src/lib/utils.test.ts`, `packages/ui/src/styles/tokens.css`, `packages/ui/src/index.ts`

**Interfaces:**
- Produces: workspace package `@swarm/ui` (resolvable after `pnpm install`); `cn(...inputs: ClassValue[]): string`; a valid shadcn `components.json` ready for `apply` in Task 2.

- [ ] **Step 1: Create `packages/ui/package.json`**

```json
{
  "name": "@swarm/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "react": ">=19",
    "react-dom": ">=19"
  },
  "dependencies": {
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.22.0",
    "tailwind-merge": "^3.6.0"
  },
  "devDependencies": {
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```
> Radix primitives are NOT seeded — the preset (Task 2) adds the ones each component needs via the shadcn CLI.

- [ ] **Step 2: Create `packages/ui/tsconfig.json`**

```json
{
  "extends": "../../tools/tsconfig/base.json",
  "include": ["src/**/*"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

- [ ] **Step 3: Create `packages/ui/components.json`**

```json
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
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 4: Create `packages/ui/src/lib/utils.ts`** (verbatim from desktop)

```ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 5: Create `packages/ui/src/lib/utils.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('merges class names and resolves tailwind conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('a', false, undefined, 'b')).toBe('a b')
  })
})
```

- [ ] **Step 6: Create `packages/ui/src/styles/tokens.css`** (portable token block — single source of truth)

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  --font-heading: var(--font-sans);
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --color-foreground: var(--foreground);
  --color-background: var(--background);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  --background: transparent;
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
  /* --system-accent is overwritten at runtime by the desktop preload bridge;
     the extension (no bridge) keeps this default blue. */
  --system-accent: oklch(0.55 0.18 264);
  --primary: var(--system-accent);
  --primary-foreground: oklch(0.985 0 0);
  --sidebar-primary: var(--system-accent);
  --sidebar-primary-foreground: oklch(0.985 0 0);
}

.dark {
  --background: transparent;
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --sidebar: oklch(0.24 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
  --primary: var(--system-accent, oklch(0.922 0 0));
  --primary-foreground: oklch(0.205 0 0);
  --sidebar-primary: var(--system-accent, oklch(0.488 0.243 264.376));
  --sidebar-primary-foreground: oklch(0.985 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```
> App-specific concerns (streamdown `@source`, macOS chrome `user-select`/`cursor`/transparent-body, `--window-content` vibrancy token) are intentionally NOT here — they stay in desktop's `globals.css`.

- [ ] **Step 7: Create a stub `packages/ui/src/index.ts`** (the barrel is regenerated in Task 2 after the preset adds components)

```ts
export * from './lib/utils'
```

- [ ] **Step 8: Relink the workspace**

Run: `pnpm install`
Expected: `@swarm/ui` is linked; `packages/ui` appears under "Progress" with no resolution errors.

- [ ] **Step 9: Run the `cn` test**

Run: `pnpm --filter @swarm/ui test`
Expected: `utils.test.ts` passes (1 test).

- [ ] **Step 10: Typecheck the package**

Run: `pnpm --filter @swarm/ui typecheck`
Expected: no errors.

- [ ] **Step 11: Format new files (scoped — `pnpm check` would reformat the whole repo)**

Run: `npx biome check --write packages/ui`
Expected: no changes that break anything; exit 0.

- [ ] **Step 12: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): scaffold @swarm/ui workspace package

Source-only package mirroring @swarm/shared: cn util (+test), portable
Tailwind v4 token CSS, and a shadcn components.json. No components yet —
populated by the preset in the next commit."
```

---

### Task 2: Apply the preset and finalize the package surface

**Files:**
- Create: `packages/ui/vite.config.ts` (permanent shadcn framework marker — see Step 1)
- Modify: `packages/ui/components.json` (preset may rewrite — verify aliases after)
- Create: `packages/ui/src/components/ui/*` (by the preset)
- Regenerate: `packages/ui/src/index.ts` (barrel)
- Possibly modify: `packages/ui/src/styles/tokens.css`, `packages/ui/package.json` (preset may add Radix deps)

**Interfaces:**
- Produces: a populated `@swarm/ui` exporting `cn` + the starter components (`button`, `card`, `input`, `label`, `sonner`); a `package.json` whose `dependencies` include the Base UI primitives (`@base-ui/react`) the `base-sera` style uses.

**User-approved direction (supersedes Task 1's `base-nova`/Radix assumption):** the preset `b1abxEJN2` is **theme-only** and rethemes the package to `base-sera` / `zinc` / Montserrat / **Base UI** (not Radix). The user approved adopting this preset's theme. Therefore: KEEP the preset's `components.json` (base-sera/zinc), KEEP the preset's `tokens.css` (do NOT restore Task 1's native block), KEEP its added deps (`@base-ui/react`, `@fontsource-variable/montserrat`, `tw-animate-css`), and add components separately via `shadcn add`. (Consequence: the extension, which consumes these tokens, becomes base-sera-themed; desktop keeps its own native `globals.css` — divergence accepted.)

- [ ] **Step 1: Create the shadcn framework marker, then apply the preset (KEEP its theme)**

shadcn 4.12.0's framework detector globs the cwd (deep:3) for `vite.config.*|next.config.*|…`. Task 1's package is source-only with no such marker, so `apply` exits 1 with "could not detect a supported framework" **before** fetching the preset (verified during execution). Create a permanent minimal marker first.

Create `packages/ui/vite.config.ts`:
```ts
// shadcn CLI requires a framework marker (vite.config.*) to detect the project
// type before `apply`/`add`. This file exists solely for that detection — the
// package has no build step and is consumed from source via the apps' vite
// aliases. It lives outside the package tsconfig `include`, so it is never
// typechecked, and turbo never builds it (no `build` script).
export default {}
```
Then run the preset. `bunx --bun` fails at dep-install (Bun 1.3.14 lacks `node:sqlite`, which the CLI uses), so use `npx` (node runtime):
```bash
cd packages/ui
npx shadcn@latest apply --preset b1abxEJN2 --yes
cd ../..
```
Expected: the preset writes `src/lib/utils.ts` + `src/styles/tokens.css`, sets `components.json` to `style: base-sera` / `baseColor: zinc`, and adds deps (`@base-ui/react`, `@fontsource-variable/montserrat`, `tw-animate-css`, and a `shadcn` self-dep). **The preset is theme-only — no components are written yet (Step 2 adds them).** KEEP the preset's `tokens.css` and `components.json` (base-sera is intended). **The marker is permanent — do NOT delete it** (future `shadcn add` calls need it too).

- [ ] **Step 2: Add the starter component set (`shadcn add`)**

The preset ships no components. Add the user-approved starter set:
```bash
cd packages/ui
npx shadcn@latest add button card input label sonner --yes
cd ../..
```
Expected: `src/components/ui/{button,card,input,label,sonner}.tsx` are created, each pulling its `@base-ui/react` primitives into `package.json` automatically. Use `npx` (same Bun `node:sqlite` limitation).

- [ ] **Step 3: Verify `components.json` + tokens reflect base-sera**

Run: `cat packages/ui/components.json` → `style: base-sera`, `baseColor: zinc`; aliases intact (`ui=@/components/ui`, `utils=@/lib/utils`, `css=src/styles/tokens.css`).
Run: `grep -E '^\\s*--background:|^\\s*--primary:|^\\.dark|montserrat' packages/ui/src/styles/tokens.css` → matches (base-sera theme + Montserrat). The preset's `tokens.css` is canonical now — do NOT restore Task 1's native block.

- [ ] **Step 4: Clean the bogus `shadcn` self-dep (conditionally)**

The preset adds `shadcn@^4.12.0` to `dependencies`. Whether it's needed depends on the theme CSS:
`grep "shadcn/tailwind" packages/ui/src/styles/tokens.css`
- If it matches (`@import "shadcn/tailwind.css"` is used): KEEP the `shadcn` dep — it ships that CSS.
- If no match: remove the self-dep — `pnpm --filter @swarm/ui remove shadcn`.

- [ ] **Step 5: Install deps + verify resolution**

Run: `pnpm install`
Expected: lockfile + `node_modules` updated for `@base-ui/react`, the Montserrat fontsource, `tw-animate-css`, and any extra Base UI primitives the components pulled in. If a component import is unresolvable at typecheck (Step 8), add the missing package with `pnpm --filter @swarm/ui add <pkg>` and re-run.

- [ ] **Step 6: Regenerate the barrel to re-export every component**

Run:
```bash
cd packages/ui
{ echo "export * from './lib/utils'"; for f in src/components/ui/*.tsx; do [ -f "$f" ] || continue; n=$(basename "$f" .tsx); echo "export * from './components/ui/$n'"; done; } > src/index.ts
cd ../..
cat packages/ui/src/index.ts
```
Expected: `src/index.ts` begins with the `utils` re-export and has one `export * from './components/ui/<name>'` line per component file.
> If a later typecheck reports an `export *` name collision (two ui files exporting the same symbol), switch those lines to explicit named exports.

- [ ] **Step 7: Format**

Run: `npx biome check --write packages/ui`
Expected: exit 0.

- [ ] **Step 8: Typecheck the package**

Run: `pnpm --filter @swarm/ui typecheck`
Expected: no errors.

- [ ] **Step 9: Test + boundary check**

Run: `pnpm --filter @swarm/ui test && node tools/check-boundaries.mjs`
Expected: test passes; boundary check prints `Boundary check OK` (Task 3 extends the checker to cover `ui`, but even now `ui` is simply not yet listed — no violation is possible because `@swarm/ui` imports only React/web libs).

- [ ] **Step 10: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): apply preset b1abxEJN2 (base-sera) + starter components

Theme-only preset rethemes @swarm/ui to base-sera/zinc/Montserrat/Base UI
(tokens.css + components.json + deps kept). Starter components (button, card,
input, label, sonner) added via shadcn add, pulling @base-ui/react primitives.
Permanent vite.config.ts marker enables the shadcn CLI's framework detection."
```

---

### Task 3: Extend the boundary checker to cover `@swarm/ui`

**Files:**
- Modify: `tools/check-boundaries.mjs`
- Modify: `biome.json` (exclude vendored `packages/ui/src/components/ui` — mirror the existing `packages/design` + desktop `src/renderer/src/components/ui` convention)
- Modify: `packages/ui/src/components/ui/label.tsx` (remove the now-moot `biome-ignore` comment)

**Interfaces:**
- Produces: a boundary gate that fails if `packages/ui/src` imports anything platform-bound while still allowing React/web libs; vendored shadcn components excluded from biome (consistent with the rest of the repo).

- [ ] **Step 1: Replace `tools/check-boundaries.mjs` with per-package rules**

Replace the entire file with:

```js
#!/usr/bin/env node
import { execSync } from 'node:child_process'
// Fails if @swarm/protocol, @swarm/shared, or @swarm/ui import anything
// platform-bound. @swarm/ui may use React/web libs but must stay Electron- and
// native-free. Run from the repo root: `node tools/check-boundaries.mjs`
import { readFileSync } from 'node:fs'

// Platform-agnostic baseline: forbids Electron, native modules, node builtins,
// provider SDKs, and React Native. React/web libs are allowed.
const FORBIDDEN_PLATFORM = [
  /^electron/,
  /^better-sqlite3$/,
  /^sqlite-vec$/,
  /^sherpa-onnx-node/,
  /^node:/,
  /^child_process$/,
  /^path$/,
  /^fs$/,
  /^os$/,
  /@anthropic-ai\//,
  /@modelcontextprotocol\//,
  /^react-native$/,
]

// Stricter rule for protocol/shared: they are pure logic consumed by non-React
// contexts (e.g. the Electron main process), so React is also forbidden.
const FORBIDDEN_NO_REACT = [...FORBIDDEN_PLATFORM, /^react$/, /^react-dom$/]

const RULES = {
  protocol: FORBIDDEN_NO_REACT,
  shared: FORBIDDEN_NO_REACT,
  ui: FORBIDDEN_PLATFORM,
}

let bad = 0
for (const [pkg, forbidden] of Object.entries(RULES)) {
  let files = []
  try {
    files = execSync(`git ls-files packages/${pkg}/src`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    /* no files yet */
  }
  for (const f of files) {
    if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('@swarm/')) continue
      if (forbidden.some((re) => re.test(spec))) {
        console.error(`BOUNDARY VIOLATION: ${f} imports "${spec}"`)
        bad++
      }
    }
  }
}
if (bad) {
  console.error(`\n${bad} boundary violation(s) in @swarm/* packages.`)
  process.exit(1)
}
console.log('Boundary check OK — no forbidden imports in @swarm/* packages.')
```

- [ ] **Step 2: Verify the checker passes for the current (clean) tree**

Run: `node tools/check-boundaries.mjs`
Expected: `Boundary check OK — no forbidden imports in @swarm/* packages.`

- [ ] **Step 3: Verify the checker actually catches a `ui` violation (negative test)**

Temporarily add a forbidden import to any `@swarm/ui` source file, e.g. edit `packages/ui/src/lib/utils.ts` and add at the top:
```ts
import { createRequire } from 'node:module' // sentinel — must be rejected
```
Run: `node tools/check-boundaries.mjs`
Expected: exits non-zero with `BOUNDARY VIOLATION: packages/ui/src/lib/utils.ts imports "node:module"`.
Then revert the sentinel line.

- [ ] **Step 4: Exclude vendored `@swarm/ui` components from biome**

The repo already excludes vendored shadcn components: `biome.json` has `!src/renderer/src/components/ui/**` and `!**/packages/design/src/components/ui/**` (the `packages/design` pattern is stale/anticipatory; `packages/ui` is the real package). Add `packages/ui` next to every `packages/design` occurrence — there are 4 locations (the `files.include` negation list around line 8, and 3 `overrides` blocks around lines 72, 87, 123). Add the matching variant: `!**/packages/ui/src/components/ui/**` beside each `!**/packages/design/src/components/ui/**`, and `!**/packages/ui/src/components/ui` beside each `!**/packages/design/src/components/ui`.

Verify: `npx biome check packages/ui/src/components/ui` → exits clean (the vendored dir is now ignored, so no a11y false positives).

- [ ] **Step 5: Remove the now-moot `biome-ignore` from `label.tsx`**

Since `packages/ui/src/components/ui` is now excluded, the per-line `biome-ignore lint/a11y/...` comment above the `<label>` in `packages/ui/src/components/ui/label.tsx` (added in Task 2) is dead. Remove just that comment line — leave the `<label>` element and the rest of the file intact. This is the one allowed edit to vendored component code in this task.

- [ ] **Step 6: Commit**

```bash
git add tools/check-boundaries.mjs biome.json packages/ui/src/components/ui/label.tsx
git commit -m "chore(boundaries,lint): enforce @swarm/ui platform-agnosticism + exclude vendored ui

Per-package boundary rules: protocol/shared forbid React; ui allows React/web
libs but forbids Electron, native modules, node builtins, RN. Mirror the
existing vendored-components biome exclusion for packages/ui/src/components/ui
and drop the now-moot label.tsx biome-ignore."
```

---

### Task 4: Wire `@swarm/ui` into the desktop renderer

**Files:**
- Modify: `packages/ui/src/components/ui/*.tsx` (rewrite `@/` imports → relative, so the package is consumer-agnostic — fixes a cross-consumer alias collision)
- Modify: `apps/desktop/electron.vite.config.ts` (renderer `resolve.alias`)
- Modify: `apps/desktop/tsconfig.web.json` (`paths` + `include`)
- Modify: `apps/desktop/package.json` (dep)
- Modify: `apps/desktop/src/renderer/src/styles/globals.css` (`@source`)

**Interfaces:**
- Consumes: `@swarm/ui` exports from Task 2.
- Produces: `import { Button } from '@swarm/ui'` resolving in the desktop renderer, with Tailwind v4 generating the component classes.

- [ ] **Step 1: Make `@swarm/ui` imports consumer-agnostic, then add the renderer vite alias**

**1a. Rewrite the package's `@/` imports to relative (do this first).** shadcn generates component imports as `@/lib/utils`. Each consumer's `@/` alias points at THAT consumer's own src, so a shared package's `@/` imports resolve to the consumer, not the package — benign for desktop (its `cn` is identical) but **breaking for the extension**, which has no `@/` alias. Fix it once, in the package: rewrite every `@/...` import in `packages/ui/src/components/ui/*.tsx` to a path relative to the file. For the 5 starter components the only such import is `@/lib/utils` → `../../lib/utils`. Find them with `grep -rn "@/" packages/ui/src/components/ui/`. Verify the package still typechecks standalone: `pnpm --filter @swarm/ui typecheck`.

**1b. Add the renderer vite alias.** In `apps/desktop/electron.vite.config.ts`, inside the `renderer.resolve.alias` object, add one entry (keep existing entries intact):

```ts
'@swarm/ui': resolve('../../packages/ui/src'),
```
The block becomes (showing context — only the new line is added):
```ts
renderer: {
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src'),
      '@swarm/protocol': resolve('../../packages/protocol/src'),
      '@swarm/shared': resolve('../../packages/shared/src'),
      '@swarm/ui': resolve('../../packages/ui/src'),
    },
  },
  // ...
```

- [ ] **Step 2: Add `@swarm/ui` to the desktop tsconfig paths + include**

In `apps/desktop/tsconfig.web.json`:
- In `compilerOptions.paths`, add:
```json
"@swarm/ui": ["../../packages/ui/src"],
"@swarm/ui/*": ["../../packages/ui/src/*"]
```
- In `include`, add `"../../packages/ui/src/**/*"`.
- In `exclude`, add `"../../packages/ui/src/**/*.test.ts"` and `"../../packages/ui/src/**/*.test.tsx"` (mirrors protocol/shared test excludes).

- [ ] **Step 3: Add the workspace dependency**

In `apps/desktop/package.json`, add to `dependencies`:
```json
"@swarm/ui": "workspace:*"
```

- [ ] **Step 4: Add the Tailwind `@source` for the package**

In `apps/desktop/src/renderer/src/styles/globals.css`, directly under the existing streamdown `@source` line (line 12), add:
```css
@source "../../../../node_modules/@swarm/ui/src";
```
> This depth (4 `..`) is identical to the streamdown line and resolves `apps/desktop/node_modules/@swarm/ui` → `packages/ui/src` after the Step 3 dep is linked. Without it, Tailwind v4 will not generate classes used only inside `@swarm/ui` components and an imported component renders unstyled.

- [ ] **Step 5: Relink and typecheck**

Run: `pnpm install && pnpm --filter @swarm/desktop typecheck`
Expected: typecheck green (cache may rebuild for the renderer).

- [ ] **Step 6: Verify wiring (static; runtime smoke is in Task 6)**

Run: `pnpm install && pnpm --filter @swarm/desktop typecheck`
Expected: typecheck green — this confirms the `tsconfig.web.json` `paths` resolve `@swarm/ui`.

Then confirm the Tailwind `@source` and the runtime vite alias are in place (these are not exercised by typecheck — the full visual proof is the Task 6 `run-desktop` smoke):
- `grep '@swarm/ui' apps/desktop/src/renderer/src/styles/globals.css` → the `@source "../../../../node_modules/@swarm/ui/src";` line is present.
- `grep '@swarm/ui' apps/desktop/electron.vite.config.ts` → the renderer `resolve.alias` entry is present.
- `ls apps/desktop/node_modules/@swarm/ui/src` → resolves (the workspace symlink exists after `pnpm install`).

> If `apps/desktop/node_modules/@swarm/ui` does not exist, `@swarm/ui` is missing from `apps/desktop/package.json` `dependencies` — fix Step 3 and re-install. The end-to-end render (vite alias bundles the package + Tailwind generates its classes) is verified visually in Task 6.

- [ ] **Step 7: Format + commit**

Run: `npx biome check --write apps/desktop/electron.vite.config.ts apps/desktop/src/renderer/src/styles/globals.css packages/ui/src/components/ui`
```bash
git add packages/ui/src/components/ui apps/desktop/electron.vite.config.ts apps/desktop/tsconfig.web.json apps/desktop/package.json apps/desktop/src/renderer/src/styles/globals.css
git commit -m "feat(desktop): consume @swarm/ui in the renderer

Vite alias + tsconfig paths + workspace dep for @swarm/ui, plus a Tailwind
@source so component classes are generated. Also rewrite the package's @/
imports to relative so it is consumer-agnostic (the extension has no @/ alias).
Desktop's own components/ui is intentionally left in place (minimal scope)."
```

---

### Task 5: Add Tailwind v4 + `@swarm/ui` to the extension

**Files:**
- Modify: `apps/extension/package.json`
- Modify: `apps/extension/wxt.config.ts`
- Modify: `apps/extension/tsconfig.json`
- Create: `apps/extension/entrypoints/popup/globals.css`, `apps/extension/entrypoints/options/globals.css`
- Modify: `apps/extension/entrypoints/popup/main.tsx`, `apps/extension/entrypoints/options/main.tsx`
- Modify: `apps/extension/entrypoints/popup/Popup.tsx` (real smoke usage)

**Interfaces:**
- Consumes: `@swarm/ui` exports; the `tokens.css` design tokens.
- Produces: an extension whose popup/options are styled by the shared Tailwind v4 token system and can use any `@swarm/ui` component.

- [ ] **Step 1: Add deps to `apps/extension/package.json`**

Add to `dependencies`:
```json
"@swarm/ui": "workspace:*"
```
Add to `devDependencies`:
```json
"@tailwindcss/vite": "^4.3.2",
"tailwindcss": "^4.3.2",
"tw-animate-css": "^1.4.0"
```

- [ ] **Step 2: Add the Tailwind plugin + `@swarm/ui` alias to `wxt.config.ts`**

Replace `apps/extension/wxt.config.ts` with:

```ts
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// WXT auto-generates manifest.json from entrypoints + the manifest block below.
// @swarm/protocol and @swarm/ui are bundled from source via the vite aliases
// (no package build). Tailwind v4 is wired through @tailwindcss/vite; each
// entrypoint imports its globals.css which pulls the shared token CSS.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'SwarmAgents',
    version: '0.1.0',
    description: 'Quick launcher for the SwarmAgents desktop runtime.',
    permissions: ['storage', 'alarms'],
    host_permissions: ['ws://127.0.0.1:47777/*', 'http://127.0.0.1:47777/*'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@swarm/protocol': resolve(__dirname, '../../packages/protocol/src'),
        '@swarm/ui': resolve(__dirname, '../../packages/ui/src'),
      },
    },
  }),
})
```

- [ ] **Step 3: Add `@swarm/ui` to the extension tsconfig**

In `apps/extension/tsconfig.json`:
- In `compilerOptions.paths`, add:
```json
"@swarm/ui": ["../../packages/ui/src"],
"@swarm/ui/*": ["../../packages/ui/src/*"]
```
- In `include`, add `"../../packages/ui/src/**/*"`.

- [ ] **Step 4: Create `apps/extension/entrypoints/popup/globals.css`**

```css
/* @swarm/ui's tokens.css is the base-sera Tailwind v4 theme entry — it pulls in
   tailwindcss (or shadcn/tailwind.css) + tw-animate-css + the theme tokens. So
   import ONLY it here; do NOT also @import "tailwindcss" (duplicate import).
   If the build errors that tailwind isn't loaded, prepend `@import "tailwindcss";`
   above — but first confirm the package tokens.css doesn't already import it. */
@import "@swarm/ui/src/styles/tokens.css";

/* Tailwind v4 does not scan outside this CSS file's subtree; source the shared
   component classes from the workspace symlink (apps/extension/node_modules/@swarm/ui). */
@source "../../node_modules/@swarm/ui/src";

html,
body {
  width: 320px;
}
```
> If the build fails to resolve `@import "@swarm/ui/src/styles/tokens.css"`, replace that line with the explicit relative form `@import "../../node_modules/@swarm/ui/src/styles/tokens.css";` (bare-specifier CSS imports resolve via node_modules, independent of the JS vite alias — verify which form your `@tailwindcss/vite` version accepts).

- [ ] **Step 5: Create `apps/extension/entrypoints/options/globals.css`**

```css
@import "@swarm/ui/src/styles/tokens.css";

@source "../../node_modules/@swarm/ui/src";
```
(Same single-import-of-package-tokens + source as popup; options is wider, no fixed width.)

- [ ] **Step 6: Import the CSS in each entrypoint's `main.tsx`**

In `apps/extension/entrypoints/popup/main.tsx`, add as the first import (before `import React`):
```ts
import './globals.css'
```
In `apps/extension/entrypoints/options/main.tsx`, add the same first import:
```ts
import './globals.css'
```

- [ ] **Step 7: Ensure `button` exists in `@swarm/ui`, then use it in the popup**

First confirm the component is present:
Run: `ls packages/ui/src/components/ui/button.tsx`
If missing, add it:
```bash
cd packages/ui && bunx --bun shadcn@latest add button && cd ../..
```

Then edit `apps/extension/entrypoints/popup/Popup.tsx`:
- Add the import with the other imports at the top:
```ts
import { Button } from '@swarm/ui'
```
- Replace the raw `<button disabled={busy} onClick={probe} style={{ width: '100%' }}>` element and its closing `</button>` with:
```tsx
<Button className="w-full" disabled={busy} onClick={probe}>
  {busy ? '…' : 'test connection'}
</Button>
```
Leave the rest of `Popup.tsx` (state, probe logic, result rendering) unchanged.

- [ ] **Step 8: Relink + build the extension**

Run: `pnpm install && pnpm --filter @swarm/extension build`
Expected: WXT build succeeds; `.output/` contains the built popup/options with inlined CSS. If a Radix package fails to resolve, add it to the extension's devDependencies (hoisting usually covers it, but MV builds can be stricter) and rebuild.

- [ ] **Step 9: Typecheck the extension**

Run: `pnpm --filter @swarm/extension typecheck`
Expected: no errors. (If the `@wxt-dev/module-react` types differ, the existing popup already builds, so this should be unchanged apart from the new `@swarm/ui` import resolving.)

- [ ] **Step 10: Load the popup and verify styling**

Load the built extension in Chrome (`chrome://extensions` → Load unpacked → `apps/extension/.output/chromium-mv3`), open the popup, and screenshot. Confirm:
- The "test connection" button has the primary accent background, rounded corners, and the system font.
- The popup is 320px wide with the token background (not the browser default).

> If the button is unstyled, the `@source` path did not resolve — confirm `ls apps/extension/node_modules/@swarm/ui/src` lists components and fix the relative depth in `globals.css`.

- [ ] **Step 11: Format + commit**

Run: `npx biome check --write apps/extension`
```bash
git add apps/extension
git commit -m "feat(extension): adopt Tailwind v4 + @swarm/ui

Wire @tailwindcss/vite + @swarm/ui alias; each entrypoint imports a globals.css
that pulls the shared token CSS. Popup's raw button is replaced with @swarm/ui
Button as the first real shared-component usage."
```

---

### Task 6: Final verification and follow-up notes

**Files:** none modified (verification-only), unless a fix surfaced.

- [ ] **Step 1: Full workspace typecheck**

Run: `pnpm typecheck`
Expected: all packages (`@swarm/desktop`, `@swarm/extension`, `@swarm/ui`, …) typecheck green.

- [ ] **Step 2: Boundary check**

Run: `node tools/check-boundaries.mjs`
Expected: `Boundary check OK — no forbidden imports in @swarm/* packages.`

- [ ] **Step 3: Extension build**

Run: `pnpm --filter @swarm/extension build`
Expected: success.

- [ ] **Step 4: Desktop smoke**

Run: `pnpm --filter @swarm/desktop typecheck` (already covered) and, if not done in Task 4, a quick `run-desktop` launch to confirm the app still boots with the `@source` change.

- [ ] **Step 5: Record follow-ups in the spec**

Append to `docs/superpowers/specs/2026-07-02-shadcn-shared-ui-package-design.md` §9 a one-line status: "Option 1 landed on `<branch>`; Option 2/3 and desktop single-source tokens remain open." Commit the doc touch:
```bash
git add docs/superpowers/specs/2026-07-02-shadcn-shared-ui-package-design.md
git commit -m "docs(spec): mark @swarm/ui Option 1 as landed"
```

- [ ] **Step 6: Integration handoff (finishing-a-development-branch)**

When all tasks pass, follow superpowers:finishing-a-development-branch to merge the worktree branch back to `develop` via `git rebase develop` then `git merge --ff-only` (per the worktree-rebase-before-merge convention), and remove the worktree.
