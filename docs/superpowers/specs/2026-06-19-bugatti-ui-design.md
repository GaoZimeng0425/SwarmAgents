# Bugatti UI Refactor — Design

**Date:** 2026-06-19
**Scope:** Main window + Settings window (renderer styling only)
**Source design:** `DESIGN-bugatti.md`

## Goal

Restyle the SwarmAgents renderer into the Bugatti design language — an austere
luxury-automotive aesthetic: pure-black canvas, white type, no accent color, no
chrome. Single theme, no light mode.

## Fidelity: tool-adapted, not literal

Bugatti's system is built for a marketing site (full-bleed car photography,
64px hero type, 120px section rhythm, serif body). SwarmAgents is an
information-dense agent tool. We translate the brand **language** into the
tool's component vocabulary and drop the marketing traits that hurt usability.

**Kept (brand soul):** pure-black canvas, white type, no accent color,
uppercase wide-tracked display headings, transparent pill buttons with a 1px
white outline, 0px radius everywhere except buttons, hairline dividers,
underline-only inputs, Mono uppercase labels/captions, the ice-blue (`#c3d9f3`)
link as the only non-monochrome color.

**Dropped (tool-adapted):** automotive photography (no source imagery — depth
comes from typography scale + whitespace + near-black surface tones instead),
serif body (kept system sans for readability of chat/code), global uppercase
body, 64px hero type, 120px marketing section spacing.

**CJK note:** the UI is bilingual. Uppercase/letter-spacing is a Latin
treatment that doesn't apply to Chinese glyphs, so uppercase is opt-in for
clearly-Latin chrome (captions, section labels) — never forced on nav/body
where CJK labels live.

## Architecture

The theme is token-driven via `src/renderer/src/styles/globals.css` CSS custom
properties consumed by ~60 shadcn components. Changing tokens restyles the bulk
automatically; signature components get targeted edits.

### Layer 0 — Theme tokens (`globals.css`)
- Monochrome palette mapped onto shadcn tokens: `--background #000`,
  `--foreground #fff`, surfaces `#0d0d0d/#141414/#1f1f1f`, hairlines
  `#262626/#3a3a3a`, body/muted `#ccc/#999`. `--primary` = white (no accent).
- `--radius: 0px` — single knob; the `--radius-*` scale derives from it, so
  everything is square. Buttons override to pill.
- Add `--link: #c3d9f3` (+ `--color-link`), `--font-display`, retarget
  `--font-heading` to display, `--font-mono` to JetBrains Mono.
- `h1–h6` → display font, weight 400, `0.04em` tracking (sentence-case kept).
- `.label-caps` utility — Mono uppercase `0.16em` for chrome labels.

### Layer 1 — Entry wiring (`entries/main.tsx`, `entries/settings.tsx`)
- `ThemeProvider` → `forcedTheme="dark"` (single pure-black theme, no toggle).
- Remove `useAccent()` (no OS system-tint bleed). `useTheme` consumers
  (`sonner`, `attachment-viewer-sheet`) keep working — they resolve to `dark`.
- Removed orphans: `components/theme-toggle.tsx`, `hooks/use-accent.ts`.
  `settings-view.tsx` theme-switcher card → static brand note.

### Layer 2 — Signature components
- **button**: default = transparent + 1px white outline, pill (`rounded-full`),
  Mono uppercase `0.14em`, weight 400; sizes pinned to pill; `link` → ice-blue.
- **input**: underline-only — transparent, bottom hairline, focus thickens to
  white, square, no ring.
- **textarea**: square hairline box (better for multiline), transparent, focus
  border white.
- **badge**: Mono uppercase `0.12em`, square, default carries hairline outline
  only (the type is the tag); `link` → ice-blue.

### Fonts (bundled, offline-safe)
`@fontsource/saira-condensed` (display, latin 400/500) +
`@fontsource/jetbrains-mono` (mono, latin 400/500). Body stays system sans.
Pure CSS/woff2 — no native deps, no rebuild.

## Out of scope
Functional/state logic, IPC, routing, component structure. Backend accent IPC
(`window.swarm.getAccent`/`onAccentChange`) left in place though the renderer no
longer consumes it.

## Verification
Built and driven in the real app (run-desktop): main shell, conversation
composer, and Settings/Providers all render the Bugatti language coherently.
`typecheck` clean; changed files lint/format clean. Two pre-existing test
failures in `use-tasks.test.tsx` (`consumePendingDeepLink` mock gap from commit
`67dd888`) are unrelated to this work and present on `develop`.
