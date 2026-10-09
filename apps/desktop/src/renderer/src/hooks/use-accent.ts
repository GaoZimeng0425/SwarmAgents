// src/renderer/src/hooks/use-accent.ts
//
// Reads the OS accent on mount, subscribes to changes, writes `--system-accent`
// onto :root. The CSS var feeds `--primary` via the fallback chain in
// globals.css. Hex format from Electron is RRGGBB or RRGGBBAA — we strip the
// alpha and emit `#RRGGBB` for CSS.
//
// Also writes `--system-accent-foreground`, but ONLY for bright accents
// (yellow / orange / green): near-white labels fail WCAG AA on those, so the
// foreground flips to near-black. Dark accents set nothing — both modes' CSS
// defaults (light-mode white, dark-mode near-black) already pass against them,
// so the runtime var never overrides the dark theme's on-accent look.
import { useEffect } from 'react'

// WCAG relative-luminance cutoff: near-white on the accent stays >= 3:1 only
// while the accent's luminance stays at or below this.
const LIGHT_ACCENT_LUMINANCE = 0.3

/** WCAG relative luminance of an RRGGBB hex string (no alpha). */
export function relativeLuminance(hex6: string): number {
  const lin = (i: number): number => {
    const c = Number.parseInt(hex6.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4)
}

/**
 * Foreground for a solid accent background: null keeps the mode's CSS default
 * (near-white in light, near-black in dark — both pass AA on mid/dark accents);
 * a value replaces it when the accent is too bright for light-mode white.
 */
export function accentForeground(hexRRGGBB: string): string | null {
  return relativeLuminance(hexRRGGBB) > LIGHT_ACCENT_LUMINANCE ? 'oklch(0.145 0 0)' : null
}

function applyAccent(hex: string | null): void {
  const root = document.documentElement
  if (!hex) {
    root.style.removeProperty('--system-accent')
    root.style.removeProperty('--system-accent-foreground')
    return
  }
  const rgb = hex.slice(0, 6)
  root.style.setProperty('--system-accent', `#${rgb}`)
  const fg = accentForeground(rgb)
  if (fg) {
    root.style.setProperty('--system-accent-foreground', fg)
  } else {
    root.style.removeProperty('--system-accent-foreground')
  }
}

export function useAccent(): void {
  useEffect(() => {
    window.swarm
      .getAccent()
      .then((hex) => {
        applyAccent(hex)
      })
      .catch(() => {
        applyAccent(null)
      })
    const unsubscribe = window.swarm.onAccentChange((hex) => {
      applyAccent(hex)
    })
    return unsubscribe
  }, [])
}
