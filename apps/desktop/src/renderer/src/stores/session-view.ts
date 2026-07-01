import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SessionViewMode = 'flat' | 'directory'

type SessionViewStore = {
  // Which way the sidebar session list is organized.
  mode: SessionViewMode
  // Manual order of directory groups (cwd values); recorded dirs come first.
  directoryOrder: string[]
  // Set of collapsed directory keys (cwd values), kept as a presence map.
  collapsed: Record<string, true>
  setMode: (mode: SessionViewMode) => void
  setDirectoryOrder: (order: string[]) => void
  toggleCollapsed: (dir: string) => void
}

// View preference for the session list. Persisted to localStorage so the
// chosen filter, directory order, and collapse state survive app restarts —
// mirrors the recent-dirs store pattern.
export const useSessionView = create<SessionViewStore>()(
  persist(
    (set) => ({
      mode: 'flat',
      directoryOrder: [],
      collapsed: {},
      setMode: (mode) => set({ mode }),
      setDirectoryOrder: (directoryOrder) => set({ directoryOrder }),
      toggleCollapsed: (dir) =>
        set((state) => {
          const collapsed = { ...state.collapsed }
          if (collapsed[dir]) delete collapsed[dir]
          else collapsed[dir] = true
          return { collapsed }
        }),
    }),
    { name: 'swarm:session-view' }
  )
)
