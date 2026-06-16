import type { SessionSummary } from '@shared/types/ui'

/**
 * After deleting `deletedId`, the session id to navigate to: the most
 * recently active remaining session, or null if none remain.
 */
export function pickNextSession(sessions: SessionSummary[], deletedId: string): string | null {
  const remaining = sessions.filter((sn) => sn.id !== deletedId).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return remaining[0]?.id ?? null
}
