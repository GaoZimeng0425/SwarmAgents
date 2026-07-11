import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { TasksView } from '@/components/views/tasks-view'
import { hydrateSession } from '@/hooks/use-messages'
import { useSessionsStore } from '@/stores/sessions'

export const Route = createFileRoute('/session/$sessionId')({
  component: SessionView,
  // `?task=<id>` deep-links to a specific task's transcript (used by the
  // scheduled-runs calendar to jump to one run's execution).
  validateSearch: (search: Record<string, unknown>): { task?: string } => ({
    task: typeof search.task === 'string' ? search.task : undefined,
  }),
})

function SessionView(): React.JSX.Element {
  const { sessionId } = Route.useParams()
  const { task: focusTaskId } = Route.useSearch()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const select = useSessionsStore((s) => s.select)
  const sessions = useSessionsStore((s) => s.sessions)

  // The URL is the source of truth; mirror it into the store and hydrate the
  // session's tasks. Every existing consumer keeps reading selectedSessionId.
  useEffect(() => {
    select(sessionId)
    void hydrateSession(qc, sessionId)
  }, [sessionId, select, qc])

  // Unknown id (stale hash / deleted elsewhere): once the list has loaded and
  // does not contain it, fall back to the session list (stays in the
  // conversation scene rather than dropping onto the dashboard).
  useEffect(() => {
    if (sessions.length > 0 && !sessions.some((s) => s.id === sessionId)) {
      void navigate({ to: '/session' })
    }
  }, [sessions, sessionId, navigate])

  return <TasksView focusTaskId={focusTaskId} />
}
