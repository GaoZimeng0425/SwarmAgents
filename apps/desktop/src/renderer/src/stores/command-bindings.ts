// Persisted user overrides for command bindings.
//
// Only the hotkey string a user rebound is stored here; default bindings always
// come from lib/commands/bindings.ts. The merge happens in `resolveBindings()`
// at read time, so defaults stay in code (and track app updates) while the
// persisted blob stays small and forward-compatible.
//
// Mirrors the zustand + persist pattern used by recent-dirs / composer-defaults.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { BindingOverrides } from '@/lib/commands/bindings'
import type { CommandId } from '@/lib/commands/definitions'

type CommandBindingsStore = {
  /** Per-command hotkey overrides. A present key replaces the default hotkey. */
  overrides: BindingOverrides
  /** Set (or replace) the hotkey for one command. */
  setBinding: (id: CommandId, hotkey: string) => void
  /** Forget a single override, reverting that command to its default hotkey. */
  resetBinding: (id: CommandId) => void
  /** Forget every override, reverting all commands to defaults. */
  resetAll: () => void
}

export const useCommandBindingsStore = create<CommandBindingsStore>()(
  persist(
    (set) => ({
      overrides: {},
      setBinding: (id, hotkey) => set((state) => ({ overrides: { ...state.overrides, [id]: hotkey } })),
      resetBinding: (id) =>
        set((state) => {
          if (!(id in state.overrides)) return state
          const { [id]: _removed, ...rest } = state.overrides
          return { overrides: rest }
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'swarm:command-bindings' }
  )
)
