// src/renderer/src/lib/prewarm-fonts.ts
//
// SKILL native-feel A.9 — prewarm fallback fonts before first user-visible
// render. A fresh WebView process has its own Core Text state; the first time
// it needs an emoji or a CJK glyph not covered by the primary font, the
// fallback font must be mapped, its glyph table parsed, and the shaper
// initialized — all during user-facing paint, which surfaces as a one-frame
// stutter or a missing-glyph rectangle. Native AppKit apps avoid this because
// system font caches are warm across processes.
//
// Fix: render a hidden span containing the expected fallback characters once,
// force one layout pass (registers the fonts with Core Text's cache), and
// remove it after a double-rAF so both layout and paint complete.
//
// Must run after <div id="root"> exists. Called once from entries/main.tsx.
export function prewarmFontFallbacks(): void {
  const span = document.createElement('span')
  span.setAttribute('aria-hidden', 'true')
  span.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none;white-space:pre'
  // Cover the fallbacks actually used: emoji, CJK, math symbols, dingbats.
  span.textContent = '😀🎉✨📦🚀 中文 日本語 한국어 ∑∫√ ✓✗'
  document.body.appendChild(span)
  // One layout pass forces font resolution into Core Text's cache.
  void span.getBoundingClientRect()
  // Double-rAF ensures layout + paint both complete before removal.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => span.remove())
  })
}
