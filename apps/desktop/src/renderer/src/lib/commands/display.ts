// Platform-aware display for command bindings.
//
// Turns a command's resolved hotkey into the tokens a `<Kbd>` group renders:
//   macOS   → symbols separated by spaces   ("⌘", "K")
//   Windows → labels separated by '+'       ("Ctrl", "K")
// Symbol/label translation and modifier order are delegated entirely to
// TanStack's formatForDisplay; we only split its output into tokens.
//
// `formatForDisplay` output shapes (verified against @tanstack/react-hotkeys):
//   mac:     "⌘ K",  "⌘ ⇧ L",  "Esc"
//   windows: "Ctrl+K", "Ctrl+Shift+L", "Esc"
// So on mac we split on whitespace, on windows on '+'. Named keys ("Esc") have
// no separator and become a single token.

import { detectPlatform, formatForDisplay } from '@tanstack/react-hotkeys'

import type { BindingOverrides } from './bindings'
import { resolveBindings } from './bindings'
import type { CommandId } from './definitions'

/** One renderable token of a hotkey (e.g. "⌘", "K", "Ctrl", "Esc"). */
export type DisplayToken = string

/** The platform we currently render for. Resolved once at module load. */
const PLATFORM = detectPlatform()

/**
 * Split a formatted hotkey string into display tokens for the current platform.
 *
 * @param formatted - output of `formatForDisplay(hotkey, { platform })`
 * @param platform - which separator rule to use
 */
function splitTokens(formatted: string, platform: 'mac' | 'windows' | 'linux'): DisplayToken[] {
  if (platform === 'mac') {
    // macOS uses space-separated symbols; collapse runs of whitespace.
    return formatted.split(/\s+/).filter(Boolean)
  }
  // Windows/Linux use '+' between labels. A bare named key ("Esc") has no '+'.
  return formatted
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Get the display tokens for a raw hotkey string on the current platform.
 * Lower-level than {@link getCommandTokens}; useful when you already have a
 * hotkey string (e.g. from the recorder's live preview).
 */
export function getHotkeyTokens(hotkey: string): DisplayToken[] {
  const formatted = formatForDisplay(hotkey, { platform: PLATFORM })
  return splitTokens(formatted, PLATFORM)
}

/**
 * Resolve a command's effective binding (default or user override) and return
 * its display tokens for the current platform. Returns null if the command has
 * no binding.
 *
 * @param id - the command id to look up
 * @param overrides - user overrides (from the command-bindings store)
 */
export function getCommandTokens(id: CommandId, overrides: BindingOverrides = {}): DisplayToken[] | null {
  const { bindings } = resolveBindings(overrides)
  const binding = bindings[id]
  if (!binding) return null
  return getHotkeyTokens(binding.hotkey)
}

/**
 * A single formatted display string (e.g. "⌘ K" or "Ctrl+K") for a command, or
 * null if unbound. Convenience for tooltips / aria-labels where a flat string
 * is more useful than tokens.
 */
export function getCommandDisplayString(id: CommandId, overrides: BindingOverrides = {}): string | null {
  const { bindings } = resolveBindings(overrides)
  const binding = bindings[id]
  if (!binding) return null
  return formatForDisplay(binding.hotkey, { platform: PLATFORM })
}
