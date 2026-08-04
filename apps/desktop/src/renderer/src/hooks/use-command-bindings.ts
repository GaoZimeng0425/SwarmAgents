// useCommandBindings — wire command handlers to their resolved hotkeys.
//
// This is the single entry point components use to declare which commands they
// handle. It reads the merged (default + user-overridden) bindings and the
// active scope, builds one array of TanStack hotkey definitions, and registers
// them in one `useHotkeys` call (hooks-safe regardless of how many commands).
//
// Scope & input filtering, expressed through TanStack options:
//   - `enabled`          — only fire when a handler exists AND the binding's
//                          scope matches the active scope. When false, the
//                          registration stays (visible in devtools) but is
//                          suppressed, exactly like the legacy `enabled` usage.
//   - `ignoreInputs`     — left to TanStack's per-hotkey default (true for bare
//                          keys like Escape, false for Ctrl/Meta shortcuts)
//                          unless a binding overrides it.
//   - `preventDefault`   — on by default via HotkeysProvider; bindings that must
//                          not swallow the event (e.g. Escape) override to false.

import type { HotkeyCallback, UseHotkeyDefinition } from '@tanstack/react-hotkeys'
import { useHotkeys } from '@tanstack/react-hotkeys'

import { resolveBindings } from '@/lib/commands/bindings'
import type { CommandId } from '@/lib/commands/definitions'
import { COMMANDS } from '@/lib/commands/definitions'
import { useCommandBindingsStore } from '@/stores/command-bindings'
import { useCommandScope } from '@/stores/command-scope'

/** A handler for a command. It receives no arguments; behavior is opaque here. */
export type CommandHandler = () => void

/** Handlers keyed by command id. Omitted ids simply have no handler here. */
export type CommandHandlers = Partial<Record<CommandId, CommandHandler>>

export interface UseCommandBindingsResult {
  /**
   * Command ids whose resolved bindings collide (same hotkey + scope). Expose
   * this so surfaces can warn the user to rebind one of them.
   */
  conflicts: CommandId[]
}

/**
 * Register keyboard handlers for the given commands.
 *
 * @param handlers - map of command id -> handler. Only commands present here
 *   are actually registered; other commands remain dormant. Pass handlers as
 *   an inline object literal — the hook tolerates a new reference each render
 *   because TanStack syncs callbacks on every render (no stale closures).
 * @returns the set of conflicting command ids, for optional UI warnings.
 *
 * @example
 * ```tsx
 * function SessionSearchDialog() {
 *   const toggle = useSearchDialog((s) => s.toggle)
 *   useCommandBindings({ 'search.toggle': () => toggle() })
 *   return <PaletteDialog />
 * }
 * ```
 */
export function useCommandBindings(handlers: CommandHandlers): UseCommandBindingsResult {
  const overrides = useCommandBindingsStore((s) => s.overrides)
  const activeScope = useCommandScope((s) => s.activeScope)

  const { bindings, conflicts } = resolveBindings(overrides)

  // Build one TanStack definition per bound command that has a handler. We
  // iterate over `handlers` (not `bindings`) so the array length tracks the
  // caller's intent; unbound or handler-less commands are skipped.
  const defs: UseHotkeyDefinition[] = []
  for (const id of Object.keys(handlers) as CommandId[]) {
    const handler = handlers[id]
    const binding = bindings[id]
    if (!handler || !binding) continue

    const callback: HotkeyCallback = () => handler()
    defs.push({
      hotkey: binding.hotkey,
      callback,
      options: {
        enabled: activeScope === binding.scope,
        ...binding.options,
        meta: { name: COMMANDS[id].name },
      },
    })
  }

  useHotkeys(defs)

  return { conflicts }
}
