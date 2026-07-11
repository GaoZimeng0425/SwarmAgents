# Liquid Glass Demo Page — Design

**Date:** 2026-07-11
**Scope:** Desktop renderer only (`apps/desktop`)
**Status:** Design — pending implementation

## Goal

Add a new standalone demo page that showcases a Liquid Glass visual style across common UI
elements (buttons, panels, cards, toolbar, list, form, dialog). The page is purely visual — no
business logic, no IPC, no data fetching. Its purpose is to validate a CSS-based glass recipe in
the SwarmAgents Electron app and serve as a styling reference.

## Background — what Glaze does and what we can reuse

Glaze (a.k.a. Claude Usage) achieves its Liquid Glass look via three stacked layers:

1. **Window-level native vibrancy** — `NSVisualEffectView` mounted by the native host, blurring the
   real desktop behind the window. SwarmAgents **already has this**: `main-window.ts` sets
   `transparent: true` + `vibrancy: 'sidebar'` + `visualEffectState: 'active'` on macOS, and
   `globals.css` sets `html, body { background: transparent }`. Layer 1 is free.

2. **Web-layer `backdrop-filter`** on panels/popovers for secondary blur on top of the native
   vibrancy. Fully supported in Chromium/Electron.

3. **Per-element native glass via `-apple-visual-effect: -apple-system-glass-material`** — a
   WebKit-only CSS property that attaches an `NSVisualEffectView` material to **each HTML element**.
   This is the part Glaze leans on most (`.bg-glass`, `.bg-glass-sidebar`, `.bg-glass-accent` in its
   `components.css`). **Chromium does not support `-apple-visual-effect`**, so this is unavailable
   in Electron.

**Conclusion:** SwarmAgents cannot replicate Glaze's per-element native material. We rely on
**layer 1 (window vibrancy, already present) + layer 2 (CSS `backdrop-filter`) + a CSS-simulated
glass recipe** (translucent background + inset highlight border + dual-layer drop shadow). This is
enough to approximate the look; the main difference is weaker "desktop wallpaper bleeding through
each panel" because panels fall back to CSS blur rather than native material.

## Glass recipe (CSS layer)

All additions land in `apps/desktop/src/renderer/src/styles/globals.css`. Nothing in the existing
token set is modified — only new tokens and utilities are appended, following the existing
`--surface-*` naming convention.

### New design tokens

Dual-valued (`:root` light + `.dark` dark), appended alongside the existing `--surface-*` tokens:

| Token | Purpose | Light value | Dark value |
|---|---|---|---|
| `--glass-bg` | translucent glass surface | `oklch(1 0 0 / 55%)` | `oklch(0.3 0 0 / 45%)` |
| `--glass-bg-strong` | stronger contrast (toolbar/sticky) | `oklch(1 0 0 / 65%)` | `oklch(0.28 0 0 / 60%)` |
| `--glass-border` | inset highlight edge (the "soul") | `oklch(1 0 0 / 40%)` | `oklch(1 0 0 / 12%)` |
| `--glass-shadow` | dual-layer drop shadow | `0 8px 10px -6px #0000001a, 0 20px 25px -5px #00000029` | `0 8px 10px -6px #00000033, 0 20px 25px -5px #00000040` |
| `--glass-blur` | panel blur radius | `24px` | `24px` |

The `inset 0 0 0 1px` border is the key — it simulates the mirror-highlight on a glass edge.
Combined with the window vibrancy showing through the translucent background, it produces the
liquid-glass illusion. The dual shadow simulates elevation. Initial values mirror Glaze's
`--blur-panel: 24px` and shadow recipe; they are tunable in one place after the page renders.

### New utilities (Tailwind v4 `@utility`)

- `.glass-panel` — `background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur));
  box-shadow: inset 0 0 0 1px var(--glass-border), var(--glass-shadow);`
- `.glass-panel-strong` — same but `--glass-bg-strong`.
- `.glass-button` — panel recipe adapted to button sizing; hover darkens background (mirrors
  Glaze's `hover:bg-control-subtle`).
- `.glass-button-accent` — background set to the existing `--system-accent` token (already bridged
  from the OS accent color via `use-accent.ts`); white text.

Corner radii reuse existing `--radius-*`: panels `rounded-2xl`, buttons `rounded-control` or
`rounded-full`.

## Page layout and sections

**Route:** `apps/desktop/src/renderer/src/routes/glass.tsx`. TanStack file-based routing regenerates
`routeTree.gen.ts` automatically.

**Rail entry:** append `{ to: '/glass', icon: Sparkles, label: '玻璃主题' }` to
`RAIL_SECTIONS.services` in `rail-config.ts` (`Sparkles` from `lucide-react`).

**Layout:** single scrolling page in a centered `max-w-[1088px]` container (mirrors
`home-dashboard.tsx`). Each section is a `<section>` with a small heading and consistent spacing.

| Section | Shows |
|---|---|
| §A Buttons | glass button (default/hover/active/disabled states), accent glass button, round icon button |
| §B Panels & cards | single glass panel (title + body), card wall (`grid-cols 1/2/3`, mirrors `running-cards.tsx`) |
| §C Toolbar | sticky-top glass toolbar (search input + button group) using `.glass-panel-strong` |
| §D List | glass list rows (icon + primary + secondary + trailing control) |
| §E Form | glass-bordered input, switch, badges/tags |
| §F Dialog | trigger button opening a `@swarm/ui` Dialog styled with `.glass-panel` |

All content is static mock text — no business logic. Page strings are Chinese per project convention.

## Files touched

**New (1):**

- `apps/desktop/src/renderer/src/routes/glass.tsx` — the demo page. Imports glass utilities from
  `globals.css` and a few base components (`Dialog`, `Badge`, `Switch`, `Input`) from `@swarm/ui`.

**Modified (2):**

- `apps/desktop/src/renderer/src/styles/globals.css` — append 5 `--glass-*` tokens (`:root` +
  `.dark`) and 4 `@utility` glass classes. Only additions; no existing token changed.
- `apps/desktop/src/renderer/src/components/rail-config.ts` — append one entry to
  `RAIL_SECTIONS.services`.

**Untouched:** `main-window.ts` (vibrancy already configured), `@swarm/ui` (style stays in desktop
per decision), existing routes/views/tokens, main process, IPC.

## Success criteria

- Running `pnpm dev` and clicking the Sparkles rail entry opens the `/glass` page.
- All six sections render; glass surfaces show translucent backdrop with the window vibrancy behind.
- Buttons exhibit hover/active/disabled states; accent button uses the OS accent color.
- The sticky toolbar remains blurred over scrolling content.
- Light and dark mode both look correct (tokens are dual-valued).
- No existing page or token regresses; diff is confined to the three files above.

## Out of scope

- Per-element native material (`-apple-visual-effect`) — unavailable in Electron.
- Extracting glass styles into `@swarm/ui` for cross-app reuse — deferred until reuse is needed.
- Any business data, IPC, or main-process changes.
- Window vibrancy tuning (already set to `sidebar`).
