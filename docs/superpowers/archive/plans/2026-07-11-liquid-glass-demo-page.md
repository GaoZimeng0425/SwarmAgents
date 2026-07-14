# Liquid Glass Demo Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone demo page at `/glass` that showcases a CSS-simulated Liquid Glass visual style across buttons, panels, cards, a toolbar, list rows, form elements, and a dialog — entered from the 64px rail.

**Architecture:** Pure CSS glass recipe layered on top of the window's existing native vibrancy. New `--glass-*` design tokens (dual-valued for light/dark) plus four Tailwind v4 `@utility` classes are appended to the desktop `globals.css`. A new route file + a one-line rail entry surface a static demo page. No business logic, no IPC, no main-process changes, no `@swarm/ui` modifications.

**Tech Stack:** Electron 43 (Chromium renderer), React 19, TanStack Router (file-based, hash history), Tailwind CSS v4.3.2 (`@utility` supported), `@swarm/ui` (shadcn-style: `Button`, `Badge`, `Switch`, `Input`, `Dialog` and sub-components).

## Global Constraints

- **Language:** Conversational/UI strings in Chinese; code comments and commit messages in English (per AGENTS.md §0).
- **Surgical changes:** Only touch the three files named in the spec. No refactoring of adjacent code, no edits to existing tokens.
- **Desktop-only:** All styles live in `apps/desktop/src/renderer/src/styles/globals.css`. Do not touch `@swarm/ui` (`packages/ui`).
- **CSS-simulated glass only:** Do NOT use `-apple-visual-effect` (Chromium/Blink does not support it — it silently no-ops). Use `backdrop-filter` + translucent `oklch()` backgrounds + `inset` box-shadow borders + dual-layer drop shadows.
- **Tailwind v4 `@utility` syntax:** Each custom class is declared as `@utility <name> { ... }` at top level in `globals.css`. This is the v4 replacement for `@layer components` / `@apply`-based custom classes.
- **No business logging required:** This is a static demo page with no business paths; AGENTS.md §5 (log every business path) does not apply.
- **`pnpm` for all package commands.** Dev server is `pnpm dev` (runs `electron-vite dev`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/desktop/src/renderer/src/styles/globals.css` | Holds the glass recipe: 5 `--glass-*` tokens (`:root` + `.dark`) and 4 `@utility` classes. Appended at end of file. | Modify (append only) |
| `apps/desktop/src/renderer/src/components/rail-config.ts` | Adds the rail entry that navigates to `/glass`. One item appended to `RAIL_SECTIONS.services`. | Modify (append one item + one import) |
| `apps/desktop/src/renderer/src/routes/glass.tsx` | The demo page route (TanStack file-based route). Thin: creates the route, renders `<GlassDemoView />`. | Create |
| `apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx` | The demo page body: six static sections (buttons, panels/cards, toolbar, list, form, dialog). Pure presentation, no data fetching. | Create |

> **Why split the route from the view?** This matches the codebase convention — every route file (`routes/usage.tsx`, `routes/workbench.tsx`, `routes/index.tsx`) is a 2-line wrapper that delegates to a `components/views/*-view.tsx`. Keeping views out of the routes dir also keeps TanStack's file-based router happy.

---

## Task 1: Glass tokens and utility classes

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles/globals.css` (append after line 189, the last rule)

**Interfaces:**
- Produces CSS tokens `--glass-bg`, `--glass-bg-strong`, `--glass-border`, `--glass-shadow`, `--glass-blur` (all available in `:root` light and `.dark` dark).
- Produces four `@utility` classes consumable as Tailwind utilities: `glass-panel`, `glass-panel-strong`, `glass-button`, `glass-button-accent`. Later tasks (the demo view) apply these to HTML elements.

- [ ] **Step 1: Append the glass tokens and utilities to `globals.css`**

Append the following block at the very end of `apps/desktop/src/renderer/src/styles/globals.css` (after the `.dark .cmdscroll::-webkit-scrollbar-thumb` rule, ~line 188):

```css
/* ── Liquid Glass demo recipe (desktop-only, CSS-simulated).
   Chromium/Blink cannot use -apple-visual-effect, so this layers a
   translucent oklch surface + backdrop-filter blur + an inset highlight
   border (the glass-edge mirror reflection) + a dual drop shadow, on top
   of the window's existing native vibrancy. Tokens are tunable in one
   place. */
:root {
  --glass-bg: oklch(1 0 0 / 55%);
  --glass-bg-strong: oklch(1 0 0 / 65%);
  --glass-border: oklch(1 0 0 / 40%);
  --glass-shadow: 0 8px 10px -6px #0000001a, 0 20px 25px -5px #00000029;
  --glass-blur: 24px;
}
.dark {
  --glass-bg: oklch(0.3 0 0 / 45%);
  --glass-bg-strong: oklch(0.28 0 0 / 60%);
  --glass-border: oklch(1 0 0 / 12%);
  --glass-shadow: 0 8px 10px -6px #00000033, 0 20px 25px -5px #00000040;
  --glass-blur: 24px;
}

@utility glass-panel {
  background-color: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: inset 0 0 0 1px var(--glass-border), var(--glass-shadow);
}
@utility glass-panel-strong {
  background-color: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: inset 0 0 0 1px var(--glass-border), var(--glass-shadow);
}
@utility glass-button {
  background-color: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: inset 0 0 0 1px var(--glass-border), var(--glass-shadow);
  transition: background-color 0.15s ease;
}
@utility glass-button:hover {
  background-color: oklch(0.6 0 0 / 18%);
}
@utility glass-button:active {
  background-color: oklch(0.6 0 0 / 28%);
}
@utility glass-button-accent {
  background-color: var(--system-accent);
  color: oklch(1 0 0);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: inset 0 0 0 1px var(--glass-border), var(--glass-shadow);
  transition: background-color 0.15s ease;
}
```

> **Note on `@utility` + pseudo-classes in Tailwind v4:** Tailwind v4's `@utility` registers a custom utility name. Pseudo-state variants (`glass-button:hover`) as separate `@utility` blocks are NOT valid v4 syntax. If the hover/active states above fail to compile, fall back to writing them as a plain CSS rule in `@layer utilities` instead. See Step 2's verification.

- [ ] **Step 2: Verify the CSS compiles under Tailwind v4**

Run the dev build (this also regenerates the renderer CSS):

```bash
cd apps/desktop && pnpm build
```

Expected: build succeeds with no CSS/postcss errors. If `@utility glass-button:hover` errors ("utility names cannot contain pseudo-classes" or similar), replace the three pseudo-state `@utility` blocks with a single `@layer utilities` block appended right after the `@utility` declarations:

```css
@layer utilities {
  .glass-button:hover {
    background-color: oklch(0.6 0 0 / 18%);
  }
  .glass-button:active {
    background-color: oklch(0.6 0 0 / 28%);
  }
}
```

Re-run `pnpm build` to confirm it compiles.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/styles/globals.css
git commit -m "feat(glass): add liquid glass CSS tokens and utilities

Append --glass-* design tokens (dual light/dark) and four @utility
classes (glass-panel, glass-panel-strong, glass-button, glass-button-accent)
that simulate the Liquid Glass look via translucent bg + backdrop-filter
+ inset highlight border + dual shadow. Desktop-only."
```

---

## Task 2: Rail entry for the demo page

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/rail-config.ts:6-16` (imports) and `:57-76` (`RAIL_SECTIONS.services` items array)

**Interfaces:**
- Consumes: nothing
- Produces: a rail item that routes to `/glass` (exact match). The route file itself is created in Task 3; until then clicking the rail item 404s, which is expected.

- [ ] **Step 1: Add `Sparkles` to the lucide-react import**

In `apps/desktop/src/renderer/src/components/rail-config.ts`, the import block at lines 6-16 currently reads:

```ts
import {
  CalendarClock,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Network,
  Newspaper,
  Rocket,
  TrendingUp,
  Video,
} from 'lucide-react'
```

Add `Sparkles` keeping alphabetical order (after `Rocket`, before `TrendingUp`):

```ts
import {
  CalendarClock,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Network,
  Newspaper,
  Rocket,
  Sparkles,
  TrendingUp,
  Video,
} from 'lucide-react'
```

- [ ] **Step 2: Append the rail item to `RAIL_SECTIONS.services`**

The `services` items array (lines 58-75) ends with the `workbench` entry. Add the glass entry after it, before the closing `]`:

```ts
      { key: 'workbench', label: '工作面板', icon: Rocket, target: { kind: 'route', to: '/workbench', match: 'exact' } },
      { key: 'glass', label: '玻璃主题', icon: Sparkles, target: { kind: 'route', to: '/glass', match: 'exact' } },
```

- [ ] **Step 3: Verify typecheck passes**

```bash
cd apps/desktop && pnpm typecheck:web
```

Expected: PASS, no errors. (The `Sparkles` icon and the new item shape match the existing `RailItem` type exactly.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/rail-config.ts
git commit -m "feat(rail): add 玻璃主题 entry routing to /glass"
```

---

## Task 3: Route file and demo view (page scaffold + buttons section)

**Files:**
- Create: `apps/desktop/src/renderer/src/routes/glass.tsx`
- Create: `apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx`

**Interfaces:**
- Consumes: `glass-panel`, `glass-button`, `glass-button-accent` utilities from Task 1.
- Produces: a working `/glass` route rendering `<GlassDemoView />`. At the end of this task the page has the title section and §A (buttons). Tasks 4-6 add the remaining sections into the same view file.

- [ ] **Step 1: Create the route file**

Create `apps/desktop/src/renderer/src/routes/glass.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'

import { GlassDemoView } from '@/components/views/glass-demo-view'

export const Route = createFileRoute('/glass')({ component: GlassDemoView })
```

This mirrors `routes/usage.tsx` and `routes/workbench.tsx` exactly (2-line route → view delegate).

- [ ] **Step 2: Create the demo view with the title section and §A buttons**

Create `apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx`:

```tsx
// Static Liquid Glass demo page. Showcases the CSS-simulated glass recipe
// (see globals.css --glass-* tokens and @utility classes) across common UI
// surfaces. No business logic, no data fetching — pure visual reference.

import { Sparkles, Search, Plus, Settings, Bell, Star } from 'lucide-react'

export function GlassDemoView(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1088px] flex-col gap-8 px-6 py-8">
          {/* Title */}
          <header className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-7 text-primary" />
              <h1 className="font-semibold text-[28px] text-foreground tracking-tight">Liquid Glass 主题预览</h1>
            </div>
            <p className="text-muted-foreground text-sm">
              纯 CSS 模拟的液态玻璃质感，叠加在窗口原生毛玻璃之上。以下控件均为静态展示。
            </p>
          </header>

          {/* §A Buttons */}
          <Section title="按钮" subtitle="glass-button / glass-button-accent，含 hover / active / disabled 状态">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="glass-button rounded-full px-4 py-2 text-sm font-medium text-foreground">
                玻璃按钮
              </button>
              <button type="button" className="glass-button-accent rounded-full px-4 py-2 text-sm font-medium">
                强调按钮
              </button>
              <button
                type="button"
                disabled
                className="glass-button rounded-full px-4 py-2 text-sm font-medium text-foreground opacity-40"
              >
                禁用按钮
              </button>
              <button
                type="button"
                aria-label="add"
                className="glass-button flex size-9 items-center justify-center rounded-full text-foreground"
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="settings"
                className="glass-button-accent flex size-9 items-center justify-center rounded-full"
              >
                <Settings className="size-4" />
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

// Small section wrapper used by every demo section. Keeps heading + content
// spacing consistent across the page, mirroring home-dashboard.tsx sections.
function Section({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-semibold text-lg text-foreground tracking-tight">{title}</h2>
        {subtitle ? <p className="text-muted-foreground text-xs">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}
```

> **Unused imports note:** `Search`, `Bell`, `Star` are imported now because Tasks 4-6 use them in this same file. If building after only Task 3, the linter may warn about unused imports. This is acceptable mid-implementation; they are consumed by the end of Task 6. If `biome`/`tsc` hard-errors (not warns) on unused, temporarily remove them and re-add in Task 4.

- [ ] **Step 3: Verify the route generates and the page renders**

Start the dev server:

```bash
pnpm dev
```

Expected: the app launches. Click the new Sparkles (✨) icon in the rail → the page shows the title and the buttons section. The buttons should show translucent glass surfaces with the native vibrancy behind. Hover/active states shift the background.

If the route 404s, ensure `routeTree.gen.ts` regenerated — TanStack's Vite plugin does this automatically in dev mode; if not, restart the dev server.

- [ ] **Step 4: Verify typecheck passes**

```bash
cd apps/desktop && pnpm typecheck:web
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/routes/glass.tsx apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx
git commit -m "feat(glass): add /glass route with title and buttons section"
```

---

## Task 4: Panels, cards, and toolbar sections

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx` (add two `<Section>` blocks before the closing `</div>` of the inner content wrapper, after the §A buttons `</Section>`)

**Interfaces:**
- Consumes: `glass-panel`, `glass-panel-strong` utilities from Task 1.

- [ ] **Step 1: Add §B panels & cards section**

In `glass-demo-view.tsx`, find the closing `</Section>` of §A (Buttons). Immediately after it, add:

```tsx
          {/* §B Panels & cards */}
          <Section title="面板与卡片" subtitle="glass-panel，单面板 + 卡片墙（1/2/3 列响应式）">
            {/* Single panel */}
            <div className="glass-panel rounded-2xl p-5">
              <h3 className="font-medium text-base text-foreground">单层面板</h3>
              <p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
                这是一个独立的玻璃面板，半透明背景叠加 backdrop-filter 模糊，inset 高光边模拟玻璃边缘反光，双层投影营造悬浮感。
              </p>
            </div>
            {/* Card wall */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: Star, title: '卡片一', body: '网格布局卡片，响应式 1/2/3 列。' },
                { icon: Bell, title: '卡片二', body: '每张卡片独立应用 glass-panel 配方。' },
                { icon: Settings, title: '卡片三', body: '卡片内容为静态占位文案。' },
              ].map((card) => (
                <div key={card.title} className="glass-panel rounded-2xl p-4">
                  <card.icon className="size-5 text-primary" />
                  <h4 className="mt-2 font-medium text-sm text-foreground">{card.title}</h4>
                  <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{card.body}</p>
                </div>
              ))}
            </div>
          </Section>
```

- [ ] **Step 2: Add §C sticky toolbar section**

Immediately after the §B `</Section>`, add:

```tsx
          {/* §C Toolbar (sticky) */}
          <Section title="工具栏" subtitle="glass-panel-strong，吸顶时保持模糊">
            <div className="glass-panel-strong sticky top-0 z-10 flex items-center gap-2 rounded-2xl p-2">
              <div className="flex flex-1 items-center gap-2 px-3">
                <Search className="size-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="搜索…"
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <button type="button" className="glass-button rounded-full px-3 py-1.5 text-xs text-foreground">
                筛选
              </button>
              <button type="button" className="glass-button-accent rounded-full px-3 py-1.5 text-xs">
                新建
              </button>
            </div>
            {/* Spacer so the sticky effect is visible when scrolling */}
            <div className="glass-panel flex h-24 items-center justify-center rounded-2xl text-muted-foreground text-xs">
              向上滚动以查看工具栏的吸顶模糊效果
            </div>
          </Section>
```

- [ ] **Step 3: Verify in dev**

```bash
pnpm dev
```

Expected: `/glass` now shows buttons + a single panel + a 3-card wall + a sticky toolbar with a search input and two buttons. Scrolling the page keeps the toolbar blurred at the top of the scroll container.

- [ ] **Step 4: Verify typecheck**

```bash
cd apps/desktop && pnpm typecheck:web
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx
git commit -m "feat(glass): add panels, card wall, and sticky toolbar sections"
```

---

## Task 5: List and form sections

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx` (add §D and §E after the §C `</Section>`)

**Interfaces:**
- Consumes: `glass-panel` (Task 1), `Badge`/`Switch`/`Input` from `@swarm/ui`.

- [ ] **Step 1: Add the `@swarm/ui` imports**

At the top of `glass-demo-view.tsx`, replace the single lucide import line with imports that also pull in the shared UI components. Add these lines after the existing `lucide-react` import:

```tsx
import { Badge, Input, Switch } from '@swarm/ui'
```

> Adjust icon imports if needed — Task 6 also uses `Bell`/`Star`; they are already imported from Task 3.

- [ ] **Step 2: Add §D list section**

After the §C `</Section>`, add:

```tsx
          {/* §D List */}
          <Section title="列表" subtitle="glass-panel 容器内逐行列表项">
            <div className="glass-panel divide-y divide-border/40 rounded-2xl">
              {[
                { icon: Star, title: '列表项一', subtitle: '次级说明文字', badge: '活跃' },
                { icon: Bell, title: '列表项二', subtitle: '次级说明文字', badge: '待办' },
                { icon: Settings, title: '列表项三', subtitle: '次级说明文字', badge: '完成' },
              ].map((row) => (
                <div key={row.title} className="flex items-center gap-3 px-4 py-3">
                  <row.icon className="size-5 text-muted-foreground" />
                  <div className="flex flex-1 flex-col">
                    <span className="font-medium text-sm text-foreground">{row.title}</span>
                    <span className="text-muted-foreground text-xs">{row.subtitle}</span>
                  </div>
                  <Badge variant="secondary">{row.badge}</Badge>
                </div>
              ))}
            </div>
          </Section>
```

- [ ] **Step 3: Add §E form section**

After the §D `</Section>`, add:

```tsx
          {/* §E Form elements */}
          <Section title="表单元素" subtitle="输入框 / 开关 / 标签，套玻璃边框">
            <div className="glass-panel flex flex-col gap-4 rounded-2xl p-5">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="glass-input" className="text-sm font-medium text-foreground">
                  输入框
                </label>
                <Input id="glass-input" placeholder="输入一些内容…" className="rounded-xl" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">通知开关</span>
                <Switch />
              </div>
              <div className="flex items-center gap-2">
                <Badge>默认</Badge>
                <Badge variant="secondary">次级</Badge>
                <Badge variant="outline">描边</Badge>
              </div>
            </div>
          </Section>
```

- [ ] **Step 4: Verify in dev**

```bash
pnpm dev
```

Expected: `/glass` now also shows a glass list with three rows (icon + title + subtitle + badge) and a form panel with an input, a switch, and three badges. The `Input` and `Switch` use `@swarm/ui` styling; they sit inside a glass-panel container.

- [ ] **Step 5: Verify typecheck**

```bash
cd apps/desktop && pnpm typecheck:web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx
git commit -m "feat(glass): add list and form sections"
```

---

## Task 6: Dialog section and final polish

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx` (add §F after §E; add Dialog import)

**Interfaces:**
- Consumes: `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogTrigger`/`DialogFooter`/`DialogClose` from `@swarm/ui`, `glass-panel` from Task 1.

- [ ] **Step 1: Extend the `@swarm/ui` import with Dialog sub-components**

In `glass-demo-view.tsx`, update the `@swarm/ui` import line (added in Task 5) to:

```tsx
import {
  Badge,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Switch,
} from '@swarm/ui'
```

- [ ] **Step 2: Add §F dialog section**

After the §E `</Section>`, add:

```tsx
          {/* §F Dialog */}
          <Section title="弹层" subtitle="@swarm/ui Dialog，内容区套 glass-panel">
            <Dialog>
              <DialogTrigger render={
                <button type="button" className="glass-button-accent rounded-full px-4 py-2 text-sm font-medium">
                  打开弹窗
                </button>
              } />
              <DialogContent className="glass-panel rounded-2xl">
                <DialogHeader>
                  <DialogTitle>玻璃弹窗</DialogTitle>
                  <DialogDescription>
                    这是一个套用了 glass-panel 样式的弹窗内容区。
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                  <p className="text-muted-foreground text-sm">
                    弹窗内的半透明玻璃面板，同样叠加在窗口原生毛玻璃之上。
                  </p>
                </div>
                <DialogFooter>
                  <DialogClose render={
                    <button type="button" className="glass-button rounded-full px-4 py-2 text-sm text-foreground">
                      关闭
                    </button>
                  } />
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Section>
```

> **`render` prop note:** `@swarm/ui` is built on Base UI (`@base-ui/react`), where `DialogTrigger`/`DialogClose` use the `render` prop (not `asChild` like classic shadcn/Radix). If `render={<button />}` does not wire up correctly, check `packages/ui/src/components/ui/dialog.tsx` for the exact prop — it may be `render` or it may pass through children. The intent is: the trigger is our glass button, not a default shadcn button.

- [ ] **Step 3: Verify in dev**

```bash
pnpm dev
```

Expected: `/glass` now has a "打开弹窗" button at the bottom. Clicking it opens a dialog whose content area uses the glass-panel translucent style. Closing works.

- [ ] **Step 4: Verify the full page**

With all six sections present, confirm the complete `/glass` page shows:
1. Title header
2. §A Buttons (5 buttons + states)
3. §B Panels & cards (1 panel + 3-card wall)
4. §C Toolbar (sticky, search + 2 buttons)
5. §D List (3 rows)
6. §E Form (input + switch + 3 badges)
7. §F Dialog (trigger + dialog)

Also toggle the app between light and dark mode (Settings → 通用 → theme) and confirm the glass surfaces adapt (dark mode uses the `.dark` token values).

- [ ] **Step 5: Verify typecheck**

```bash
cd apps/desktop && pnpm typecheck:web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/views/glass-demo-view.tsx
git commit -m "feat(glass): add dialog section and complete the demo page"
```

---

## Self-Review Notes

**Spec coverage:**
- §A buttons → Task 3 ✓
- §B panels & cards → Task 4 ✓
- §C toolbar → Task 4 ✓
- §D list → Task 5 ✓
- §E form → Task 5 ✓
- §F dialog → Task 6 ✓
- Glass tokens + 4 utilities → Task 1 ✓
- Rail entry → Task 2 ✓
- Route file → Task 3 ✓
- Light/dark dual values → Task 1 (`:root` + `.dark`) ✓

**Known risks flagged in-plan:**
1. Tailwind v4 `@utility` with `:hover`/`:active` pseudo-classes may not be valid syntax — fallback provided in Task 1 Step 2.
2. Base UI `DialogTrigger`/`DialogClose` use `render` prop (not `asChild`) — flagged in Task 6 Step 2.
3. Unused imports (`Search`/`Bell`/`Star`) between Task 3 and Task 6 — flagged in Task 3 Step 2.

These are the three places to watch during execution; each has a documented fallback.
