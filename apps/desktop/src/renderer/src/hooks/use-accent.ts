// src/renderer/src/hooks/use-accent.ts
//
// Reads the OS accent on mount, subscribes to changes, writes `--system-accent`
// onto :root. The CSS var feeds `--primary` via the fallback chain in
// globals.css. Hex format from Electron is RRGGBB or RRGGBBAA — we strip the
// alpha and emit `#RRGGBB` for CSS.
import { useEffect } from 'react'

function applyAccent(hex: string | null): void {
  const root = document.documentElement
  if (!hex) {
    root.style.removeProperty('--system-accent')
    return
  }
  const css = `#${hex.slice(0, 6)}`
  root.style.setProperty('--system-accent', css)
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
