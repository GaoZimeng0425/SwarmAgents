// Default key bindings + conflict resolution.
//
// Bindings map a command id to a concrete hotkey string plus scope/options.
// They live apart from command definitions (./definitions.ts) and from the
// persisted user overrides (stores/command-bindings.ts) so that:
//   - defaults ship with the app as plain data;
//   - users can rebind any command by overriding only the hotkey string;
//   - the merge of defaults + overrides is a single pure function we can test.
//
// Portability: every cross-platform binding uses the `Mod+` modifier, which
// TanStack Hotkeys resolves to Command (⌘) on macOS and Control elsewhere.
// Platform-specific display glyphs are derived in ./display.ts.

import type { Hotkey, HotkeyOptions } from '@tanstack/react-hotkeys'

import type { Command, CommandId, CommandScope } from './definitions'
import { COMMANDS } from './definitions'

/**
 * A concrete binding for a command. The `hotkey` is what TanStack registers;
 * `scope` and `options` refine where/when it fires.
 */
export interface CommandBinding {
  /** The hotkey string, e.g. `Mod+K` or `Escape`. Use `Mod+` for portability. */
  hotkey: Hotkey
  /** Scope this binding is active in (matched against the active scope). */
  scope: CommandScope
  /** Per-binding TanStack options, merged over the command's `defaultOptions`. */
  options?: Partial<HotkeyOptions>
}

/**
 * Default bindings shipped with the app. Keys must cover every command a user
 * can trigger by keyboard; unbound commands simply have no default hotkey.
 *
 * Each entry is also validated against {@link COMMANDS} via the
 * `Record<CommandId, ...>` type so a typo'd id fails at compile time.
 */
export const DEFAULT_BINDINGS: Partial<Record<CommandId, CommandBinding>> = {
  'app.newSession': { hotkey: 'Mod+N', scope: 'global' },
  'app.toggleTheme': { hotkey: 'Mod+Shift+L', scope: 'global' },
  'app.focusComposer': { hotkey: 'Mod+L', scope: 'global' },
  'search.toggle': { hotkey: 'Mod+K', scope: 'global' },
  'settings.open': { hotkey: 'Mod+,', scope: 'global' },
  'settings.close': { hotkey: 'Escape', scope: 'dialog', options: { ignoreInputs: false } },
  'permission.skipTop': { hotkey: 'Escape', scope: 'global' },
}

/**
 * User overrides keyed by command id. A present entry replaces the default
 * hotkey string only; scope/options still come from {@link DEFAULT_BINDINGS}.
 * Stored by the persisted `command-bindings` store.
 */
export type BindingOverrides = Partial<Record<CommandId, Hotkey>>

/** Result of merging defaults with overrides. */
export interface ResolvedBindings {
  /** Every command id that has a binding, mapped to its resolved binding. */
  bindings: Partial<Record<CommandId, CommandBinding>>
  /**
   * Command ids whose resolved hotkey+scope collide with another command's.
   * Callers should warn the user; colliding commands still register (TanStack's
   * default `conflictBehavior` is `warn`), but only one will reliably fire.
   */
  conflicts: CommandId[]
}

/**
 * Merge {@link DEFAULT_BINDINGS} with user {@link BindingOverrides} and detect
 * conflicts. Pure and side-effect-free, so it is unit-testable.
 *
 * Two commands conflict when they share the same `hotkey` AND `scope`: the same
 * physical key combination in the same activation context would fire both.
 * `Mod+K` (global) vs `Escape` (dialog) therefore never conflict.
 *
 * @param overrides - optional user overrides; omit entries to keep defaults.
 */
export function resolveBindings(overrides: BindingOverrides = {}): ResolvedBindings {
  const bindings: Partial<Record<CommandId, CommandBinding>> = {}

  for (const id of Object.keys(DEFAULT_BINDINGS) as CommandId[]) {
    const def = DEFAULT_BINDINGS[id]
    if (!def) continue
    const overriddenHotkey = overrides[id]
    // Merge the command's own defaultOptions (e.g. preventDefault:false for
    // Escape) under the binding's per-binding options, so both layers apply.
    // `COMMANDS` uses `satisfies`, which preserves each branch's literal type;
    // widening to `Command` here so the optional `defaultOptions` is visible on
    // every branch (undefined where the literal omits it). Safe because
    // `satisfies Record<CommandId, Command>` already guarantees conformance.
    const command = COMMANDS[id] as Command
    bindings[id] = {
      hotkey: overriddenHotkey ?? def.hotkey,
      scope: def.scope,
      options: { ...command.defaultOptions, ...def.options },
    }
  }

  return { bindings, conflicts: detectConflicts(bindings) }
}

/**
 * Find commands that resolve to the same (hotkey, scope) pair.
 */
function detectConflicts(bindings: Partial<Record<CommandId, CommandBinding>>): CommandId[] {
  // Group command ids by their `${hotkey} @ ${scope}` signature.
  const groups = new Map<string, CommandId[]>()

  for (const id of Object.keys(bindings) as CommandId[]) {
    const b = bindings[id]
    if (!b) continue
    const sig = `${b.hotkey}@${b.scope}`
    const arr = groups.get(sig)
    if (arr) arr.push(id)
    else groups.set(sig, [id])
  }

  const conflicts: CommandId[] = []
  for (const ids of groups.values()) {
    if (ids.length > 1) conflicts.push(...ids)
  }
  return conflicts
}
