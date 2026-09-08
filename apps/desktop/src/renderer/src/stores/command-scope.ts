// Runtime command scope store.
//
// TanStack Hotkeys has no built-in notion of "scope", so we model one here as
// a stack. A command's binding is active only when the current top-of-stack
// scope matches the binding's scope (see useCommandBindings). Dialogs push
// their scope on mount and pop on unmount, so their commands take precedence
// and global-scoped commands with the same key are suppressed.
//
// The stack is LIFO; callers must pair every `pushScope` with a `popScope`.

import { create } from 'zustand'

import type { CommandScope } from '@/lib/commands/definitions'

type CommandScopeStore = {
  /** The scope stack. `activeScope` is the top element, or `global` when empty. */
  stack: CommandScope[]
  /** Read-only: the currently active scope (top of the stack, or `global`). */
  activeScope: CommandScope
  /** Push a scope onto the stack (e.g. when a dialog mounts). */
  pushScope: (scope: CommandScope) => void
  /**
   * Pop the topmost occurrence of `scope` off the stack. Passing the scope
   * (rather than popping blindly) keeps nested push/pop pairs balanced even
   * if a parent was popped first in error.
   */
  popScope: (scope: CommandScope) => void
}

function topOf(stack: CommandScope[]): CommandScope {
  return stack.length > 0 ? (stack[stack.length - 1] as CommandScope) : 'global'
}

export const useCommandScope = create<CommandScopeStore>((set) => ({
  stack: [],
  activeScope: 'global',
  pushScope: (scope) =>
    set((state) => {
      const stack = [...state.stack, scope]
      return { stack, activeScope: topOf(stack) }
    }),
  popScope: (scope) =>
    set((state) => {
      // Remove the last occurrence of `scope` so matched pairs stay balanced.
      const idx = [...state.stack].reverse().findIndex((s) => s === scope)
      if (idx === -1) return state
      const realIdx = state.stack.length - 1 - idx
      const stack = state.stack.filter((_, i) => i !== realIdx)
      return { stack, activeScope: topOf(stack) }
    }),
}))
