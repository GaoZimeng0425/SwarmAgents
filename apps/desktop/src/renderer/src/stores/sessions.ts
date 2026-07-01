import type { SessionSettings, SessionSummary } from '@swarm/protocol'
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
  reorder: (orderedIds: string[]) => void
  // Optimistically merge persisted composer settings into a session entry
  // (no-op if the session isn't in the store yet).
  setSettings: (id: string, settings: SessionSettings) => void
}

// The system session ("定时任务") always sits at the very top; then pinned
// sessions; within each group, manual sort_order ascending.
const byPinnedThenSortOrder = (a: SessionSummary, b: SessionSummary): number =>
  Number(b.isSystem) - Number(a.isSystem) || Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder

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
  setSessions: (sessions) => set({ sessions: [...sessions].sort(byPinnedThenSortOrder) }),
  upsert: (session) =>
    set((state) => {
      const existing = state.sessions.find((s) => s.id === session.id)
      const rest = state.sessions.filter((s) => s.id !== session.id)
      // A brand-new session floats to the top — mirror the backend's
      // COALESCE(MIN(sort_order), 0) - 1. The session.created event carries no
      // backend sortOrder, so the store owns this placement; an update keeps the
      // session's current position.
      const sortOrder = existing ? existing.sortOrder : rest.reduce((min, s) => Math.min(min, s.sortOrder), 0) - 1
      return { sessions: [{ ...session, sortOrder }, ...rest].sort(byPinnedThenSortOrder) }
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
  reorder: (orderedIds) =>
    set((state) => {
      const pos = new Map(orderedIds.map((id, i) => [id, i]))
      const sessions = state.sessions
        .map((s) => (pos.has(s.id) ? { ...s, sortOrder: pos.get(s.id) as number } : s))
        .sort(byPinnedThenSortOrder)
      return { sessions }
    }),
  setSettings: (id, settings) =>
    set((state) => ({ sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...settings } : s)) })),
}))
