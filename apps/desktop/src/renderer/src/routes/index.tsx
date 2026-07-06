import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { HomeDashboard } from '@/components/views/home-dashboard'
import { useSessionsStore } from '@/stores/sessions'

export const Route = createFileRoute('/')({ component: IndexView })

function IndexView(): React.JSX.Element {
  const select = useSessionsStore((s) => s.select)
  // Landing on `/` means no active session — clear stale selection so
  // session-scoped consumers (permission/ask filters) don't match an old id.
  useEffect(() => {
    select(null)
  }, [select])
  return <HomeDashboard />
}
