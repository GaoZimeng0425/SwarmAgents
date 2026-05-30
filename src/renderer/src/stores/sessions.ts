import type { SessionSummary } from '@shared/types/ui'
import { create } from 'zustand'

type SessionsStore = {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  setSessions: (sessions: SessionSummary[]) => void
  upsert: (session: SessionSummary) => void
  select: (id: string | null) => void
}

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  selectedSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  upsert: (session) =>
    set((state) => {
      const rest = state.sessions.filter((s) => s.id !== session.id)
      const merged = [session, ...rest]
      merged.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      return { sessions: merged }
    }),
  select: (id) => set({ selectedSessionId: id }),
}))
