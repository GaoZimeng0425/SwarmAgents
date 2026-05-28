// src/main/system/accent.ts
//
// Wraps Electron's systemPreferences accent-color API. On macOS returns the
// 8-hex RRGGBBAA from NSColor.controlAccentColor; on Windows the UISettings
// accent. Subscribers fire on the OS event `accent-color-changed`.
import { nativeTheme, systemPreferences } from 'electron'

export function getAccent(): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null
  try {
    return systemPreferences.getAccentColor() || null
  } catch {
    return null
  }
}

type Listener = (hex: string) => void
const listeners = new Set<Listener>()
let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true
  const fire = (): void => {
    const hex = getAccent()
    if (hex) for (const l of listeners) l(hex)
  }
  // accent-color-changed exists on macOS + Windows in Electron.
  ;(systemPreferences as unknown as { on: (e: string, cb: () => void) => void }).on('accent-color-changed', fire)
  // nativeTheme update also fires on appearance change, which can swap accent perception.
  nativeTheme.on('updated', fire)
}

export function subscribeAccent(cb: Listener): () => void {
  ensureWired()
  listeners.add(cb)
  return () => listeners.delete(cb)
}
