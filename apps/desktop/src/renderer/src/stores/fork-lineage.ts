import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Links a forked session back to its source. Keyed by the fork's session id;
// value is the source session id (the fork point messageId isn't surfaced to
// the header, so only the parent id is kept here). Populated by the renderer
// when swarmApi.forkSession resolves. Persisted to localStorage so the
// "forked from session" badge survives a restart.
export type ForkedFromMap = Record<string, string>

type ForkLineageStore = {
  forkedFrom: ForkedFromMap
  /** Record that `forkedSessionId` was branched from `sourceSessionId`. */
  markForked: (forkedSessionId: string, sourceSessionId: string) => void
  /** Drop a session from the map on BOTH sides — as a fork (key) and as a
   *  source another fork points at (value). Returns via store mutation. */
  forget: (id: string) => void
}

export const useForkLineage = create<ForkLineageStore>()(
  persist(
    (set) => ({
      forkedFrom: {},
      markForked: (forkedSessionId, sourceSessionId) =>
        set((state) =>
          state.forkedFrom[forkedSessionId] === sourceSessionId
            ? state
            : { forkedFrom: { ...state.forkedFrom, [forkedSessionId]: sourceSessionId } }
        ),
      forget: (id) =>
        set((state) => {
          if (!(id in state.forkedFrom) && !Object.values(state.forkedFrom).includes(id)) return state
          const next: ForkedFromMap = {}
          for (const [forkId, srcId] of Object.entries(state.forkedFrom)) {
            if (forkId === id || srcId === id) continue
            next[forkId] = srcId
          }
          return { forkedFrom: next }
        }),
    }),
    { name: 'swarm:fork-lineage' }
  )
)
