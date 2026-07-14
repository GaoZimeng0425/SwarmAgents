// /quick-panel — the floating panel route. Rendered inside a frameless
// BrowserWindow (see main/quick-panel/quick-panel-window.ts). Does NOT use the
// main-window layout (TitleBar / AppRail / Sidebar) — __root.tsx detects this
// route and renders only <EventsBridge /> + <Outlet />.
import { createFileRoute } from '@tanstack/react-router'

import { EventsBridge } from '@/components/events-bridge'
import { QuickPanel } from '@/components/quick-panel/quick-panel'

export const Route = createFileRoute('/quick-panel')({
  component: QuickPanelRoute,
})

function QuickPanelRoute(): React.JSX.Element {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <EventsBridge isQuickPanel />
      <QuickPanel />
    </div>
  )
}
