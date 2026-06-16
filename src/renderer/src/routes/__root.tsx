import { lazy, Suspense } from 'react'
import { createRootRoute, Outlet } from '@tanstack/react-router'

import { AppSidebar } from '@/components/app-sidebar'
import { EventsBridge } from '@/components/events-bridge'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'

// Opt-in only — devtools overlap the UI and interfere with manual/automated UI
// testing. Enable with `VITE_ROUTER_DEVTOOLS=true pnpm dev`.
const SHOW_ROUTER_DEVTOOLS = import.meta.env.DEV && import.meta.env.VITE_ROUTER_DEVTOOLS === 'true'

const RouterDevtools = SHOW_ROUTER_DEVTOOLS
  ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })))
  : (): null => null

export const Route = createRootRoute({ component: RootLayout })

function RootLayout(): React.JSX.Element {
  return (
    <SidebarProvider>
      <EventsBridge />
      <AppSidebar />
      <SidebarInset>
        {/* 06 § Materials: content pane reads as more opaque than the
            translucent vibrancy sidebar. --window-content is the material hook. */}
        <main className="flex h-svh flex-col overflow-hidden bg-[var(--window-content)]">
          <ContentTopBar />
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
      <Toaster />
      {SHOW_ROUTER_DEVTOOLS && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </SidebarProvider>
  )
}

// Draggable top strip for the content pane (replaces the old full-width TitleBar
// overlay, which would have blocked the sidebar's toolbar buttons). When the
// sidebar is collapsed it surfaces a toggle to reopen it, offset clear of the
// macOS traffic lights since the content then spans the full window width.
function ContentTopBar(): React.JSX.Element {
  const { state } = useSidebar()
  return (
    <div className="flex h-9 shrink-0 items-center px-2" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {state === 'collapsed' && (
        <div className="pl-[78px]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SidebarTrigger aria-label="Toggle sidebar" className="text-muted-foreground" />
        </div>
      )}
    </div>
  )
}
