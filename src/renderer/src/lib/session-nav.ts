import type { SessionSummary } from '@shared/types/ui'
import { orderBy } from 'es-toolkit'

/**
 * After deleting `deletedId`, the session id to navigate to: the most
 * recently active remaining session, or null if none remain.
 */
export function pickNextSession(sessions: SessionSummary[], deletedId: string): string | null {
  const remaining = orderBy(
    sessions.filter((sn) => sn.id !== deletedId),
    ['lastActiveAt'],
    ['desc']
  )
  return remaining[0]?.id ?? null
}
