// Command definitions: the registry of typed commands.
//
// A "command" is an addressable action identified by a stable id. Commands are
// deliberately kept separate from their key bindings (see ./bindings.ts) so the
// same command can be rebound by users without touching the action it performs.
//
// Handlers are NOT defined here — they are supplied at the call site by the
// component that owns the behavior (see hooks/use-command-bindings.ts). This
// keeps the registry pure data with no runtime side effects.

import type { HotkeyOptions } from '@tanstack/react-hotkeys'

/**
 * Scopes group commands so they can be enabled/disabled together based on what
 * the app is currently doing. TanStack Hotkeys has no built-in scope field, so
 * a scope is realized by gating a binding's `enabled` flag against the active
 * scope in {@link useCommandBindings}.
 *
 * - `global`  — always available (default). The vast majority of commands.
 * - `dialog`  — only while a modal dialog is open (e.g. a command palette).
 * - `editor`  — only while a text editor / composer surface has focus.
 */
export type CommandScope = 'global' | 'dialog' | 'editor'

/**
 * Stable, literal command identifiers. Adding a command means adding its id
 * here AND an entry in {@link COMMANDS}. The literal union gives callers
 * autocomplete and compile-time checking of command references.
 */
export type CommandId =
  | 'app.newSession'
  | 'app.toggleTheme'
  | 'app.focusComposer'
  | 'search.toggle'
  | 'settings.open'
  | 'settings.close'
  | 'permission.skipTop'

/**
 * A single command — metadata only, no key binding and no handler.
 */
export interface Command {
  /** Stable identifier; matches a key in {@link COMMANDS}. */
  id: CommandId
  /** Human-readable name, shown in shortcut UI / tooltips / devtools `meta`. */
  name: string
  /** Optional longer explanation of what the command does. */
  description?: string
  /** Scope this command belongs to by default (overridable in a binding). */
  defaultScope: CommandScope
  /**
   * Default TanStack Hotkeys options merged into this command's binding.
   * Use this for per-command behaviors like `preventDefault: false` or
   * `ignoreInputs`. A binding may further override these.
   */
  defaultOptions?: Partial<HotkeyOptions>
}

/**
 * The canonical command registry. To add a command:
 *   1. add its id to {@link CommandId};
 *   2. add an entry here;
 *   3. add a default binding in ./bindings.ts (`DEFAULT_BINDINGS`).
 */
export const COMMANDS = {
  'app.newSession': {
    id: 'app.newSession',
    name: 'New Session',
    description: 'Create a new conversation session.',
    defaultScope: 'global',
  },
  'app.toggleTheme': {
    id: 'app.toggleTheme',
    name: 'Toggle Theme',
    description: 'Switch between light and dark appearance.',
    defaultScope: 'global',
  },
  'app.focusComposer': {
    id: 'app.focusComposer',
    name: 'Focus Composer',
    description: 'Move keyboard focus to the message input.',
    defaultScope: 'global',
  },
  'search.toggle': {
    id: 'search.toggle',
    name: 'Toggle Search',
    description: 'Open or close the session search palette.',
    defaultScope: 'global',
  },
  'settings.open': {
    id: 'settings.open',
    name: 'Open Settings',
    description: 'Open the settings dialog.',
    defaultScope: 'global',
  },
  'settings.close': {
    id: 'settings.close',
    name: 'Close Settings',
    description: 'Close the settings dialog.',
    defaultScope: 'dialog',
  },
  'permission.skipTop': {
    id: 'permission.skipTop',
    name: 'Skip Permission Prompt',
    description: 'Skip the top-most permission prompt.',
    defaultScope: 'global',
    // Mirrors the legacy Escape handler: do not swallow the event so nested
    // Escape listeners still react, and do not prevent the browser default.
    defaultOptions: { preventDefault: false, stopPropagation: false },
  },
} satisfies Record<CommandId, Command>

/** Compile-time guarantee that COMMANDS has no missing/extra entries. */
export type CommandRegistry = typeof COMMANDS
