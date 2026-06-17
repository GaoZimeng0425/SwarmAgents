import type { SessionSummary } from '@shared/types/ui'
import { create } from 'zustand'

type SessionsStore = {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  // Client-side "has activity since you last looked" flags, keyed by session id.
  // Not persisted — a transient hint, reset on app restart.
  unread: Record<string, true>
  setSessions: (sessions: SessionSummary[]) => void
  upsert: (session: SessionSummary) => void
  remove: (id: string) => void
  select: (id: string | null) => void
  // Flag a background session as unread. No-op for the session being viewed.
  markUnread: (id: string) => void
}

// Pinned sessions float to the top; within each group, most-recently-active first.
const byPinnedThenRecent = (a: SessionSummary, b: SessionSummary): number =>
  Number(b.pinned) - Number(a.pinned) || b.lastActiveAt - a.lastActiveAt

// Immutably drop a key from the unread map (returns the same ref if absent).
const clearUnread = (unread: Record<string, true>, id: string): Record<string, true> => {
  if (!unread[id]) return unread
  const { [id]: _omit, ...rest } = unread
  return rest
}

export const useSessionsStore = create<SessionsStore>((set) => ({
  sessions: [],
  selectedSessionId: null,
  unread: {},
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
      unread: clearUnread(state.unread, id),
    })),
  // Opening a session marks it read — the route calls this on mount, so the dot
  // clears automatically when the user navigates in.
  select: (id) =>
    set((state) => ({ selectedSessionId: id, unread: id ? clearUnread(state.unread, id) : state.unread })),
  markUnread: (id) =>
    set((state) =>
      id === state.selectedSessionId || state.unread[id] ? state : { unread: { ...state.unread, [id]: true } }
    ),
}))
