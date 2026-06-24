import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// How many recently-picked working directories to remember in the composer menu.
const MAX_RECENT_DIRS = 8

type RecentDirsStore = {
  // Most-recently-used first.
  dirs: string[]
  // Record a directory as just used, moving it to the front (deduped, capped).
  add: (dir: string) => void
  // Drop a directory from history (e.g. it no longer exists).
  remove: (dir: string) => void
}

export const useRecentDirs = create<RecentDirsStore>()(
  persist(
    (set) => ({
      dirs: [],
      add: (dir) =>
        set((state) => ({
          dirs: [dir, ...state.dirs.filter((d) => d !== dir)].slice(0, MAX_RECENT_DIRS),
        })),
      remove: (dir) => set((state) => ({ dirs: state.dirs.filter((d) => d !== dir) })),
    }),
    { name: 'swarm:recent-dirs' }
  )
)
