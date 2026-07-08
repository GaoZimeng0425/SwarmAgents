import { createFileRoute, Outlet } from '@tanstack/react-router'

import { SessionPanel } from '@/components/session-panel'

// Layout for the conversation scene (`/session/*`). Owns the persistent session
// list on the left; the index (empty composer) and detail ($sessionId) routes
// render into the <Outlet> beside it, so the panel keeps its scroll/selection
// state across navigation instead of remounting per route.
export const Route = createFileRoute('/session')({ component: SessionLayout })

function SessionLayout(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0">
      <SessionPanel />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
