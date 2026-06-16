import type { SessionSummary } from '@shared/types/ui'
import { create } from 'zustand'

type SessionsStore = {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  setSessions: (sessions: SessionSummary[]) => void
  upsert: (session: SessionSummary) => void
  remove: (id: string) => void
  select: (id: string | null) => void
}

// Pinned sessions float to the top; within each group, most-recently-active first.
const byPinnedThenRecent = (a: SessionSummary, b: SessionSummary): number =>
  Number(b.pinned) - Number(a.pinned) || b.lastActiveAt - a.lastActiveAt

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  selectedSessionId: null,
  setSessions: (sessions) => set({ sessions: [...sessions].sort(byPinnedThenRecent) }),
  upsert: (session) =>
    set((state) => {
      const rest = state.sessions.filter((s) => s.id !== session.id)
      return { sessions: [session, ...rest].sort(byPinnedThenRecent) }
    }),
  remove: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
    })),
  select: (id) => set({ selectedSessionId: id }),
}))
