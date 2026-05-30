import { lazy, Suspense } from 'react'
import { createRootRoute, Outlet } from '@tanstack/react-router'

import { AppSidebar } from '@/components/app-sidebar'
import { EventsBridge } from '@/components/events-bridge'
import { TitleBar } from '@/components/title-bar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
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
      <TitleBar />
      <EventsBridge />
      <AppSidebar />
      <SidebarInset>
        {/* 06 § Materials: content pane reads as more opaque than the
            translucent vibrancy sidebar. --window-content is the material hook. */}
        <main className="h-full bg-[var(--window-content)] pt-7">
          <Outlet />
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
