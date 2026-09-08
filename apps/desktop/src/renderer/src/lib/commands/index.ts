// Public API for the keyboard command system.
//
// Consumers should import from '@/lib/commands' rather than reaching into
// individual files, so internal layout can change without breaking call sites.

export type {
  BindingOverrides,
  CommandBinding,
  ResolvedBindings,
} from './bindings'
export {
  DEFAULT_BINDINGS,
  resolveBindings,
} from './bindings'
export type {
  Command,
  CommandId,
  CommandScope,
} from './definitions'
export { COMMANDS } from './definitions'
export type { DisplayToken } from './display'
export {
  getCommandDisplayString,
  getCommandTokens,
  getHotkeyTokens,
} from './display'
