import { lazy, Suspense, useEffect } from 'react'
import { createRootRoute, Outlet, useRouter, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { AppSidebar } from '@/components/app-sidebar'
import { EventsBridge } from '@/components/events-bridge'
import { NoProviderBanner } from '@/components/no-provider-banner'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { useLoadSessions } from '@/hooks/use-tasks'
import { setSettingsReturnHref } from '@/lib/settings-return'

// Opt-in only — devtools overlap the UI and interfere with manual/automated UI
// testing. Enable with `VITE_ROUTER_DEVTOOLS=true pnpm dev`.
const SHOW_ROUTER_DEVTOOLS = import.meta.env.DEV && import.meta.env.VITE_ROUTER_DEVTOOLS === 'true'

const RouterDevtools = SHOW_ROUTER_DEVTOOLS
  ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })))
  : (): null => null

export const Route = createRootRoute({ component: RootLayout })

function RootLayout(): React.JSX.Element {
  const loadSessions = useLoadSessions()
  // Load the session list once for the whole app (the sidebar is always mounted).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; loadSessions is a stable React Query mutation
  useEffect(() => {
    loadSessions.mutate()
  }, [])

  // Full-screen takeover: the /settings route group renders its own chrome
  // (left sub-nav + Done bar), so we hide the session sidebar and top bar.
  const href = useRouterState({ select: (s) => s.location.href })
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/')

  // Remember where we were before entering Settings so "Done" can jump straight
  // back, rather than history.back()-ing through visited settings sub-pages.
  useEffect(() => {
    if (!inSettings) setSettingsReturnHref(href)
  }, [href, inSettings])

  return (
    <>
      {/* Mounted in both modes: owns event subscription + main→renderer
          navigation (incl. swarm:navigate-settings). Must never unmount. */}
      <EventsBridge />
      {inSettings ? (
        <Outlet />
      ) : (
        <SidebarProvider>
          <TopBar />
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden">
            <main className="flex h-svh flex-col overflow-hidden bg-[var(--window-content)] pt-9">
              <NoProviderBanner />
              <div className="min-h-0 flex-1">
                <Outlet />
              </div>
            </main>
          </SidebarInset>
        </SidebarProvider>
      )}
      <Toaster />
      {SHOW_ROUTER_DEVTOOLS && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
  )
}

function TopBar(): React.JSX.Element {
  const router = useRouter()
  return (
    <div
      className="fixed inset-x-0 top-0 z-30 flex h-9 shrink-0 items-center gap-0.5 bg-[var(--window-content)]/80 px-2 backdrop-blur-md"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Fixed control cluster, offset clear of the macOS traffic lights.
         no-drag so the buttons are clickable; the rest of the strip drags. */}
      <div
        className="flex items-center gap-0.5 pl-[70px]"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <SidebarTrigger aria-label="Toggle sidebar" className="text-muted-foreground" />
        <Button
          aria-label="Back"
          className="text-muted-foreground"
          onClick={() => router.history.back()}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
        <Button
          aria-label="Forward"
          className="text-muted-foreground"
          onClick={() => router.history.forward()}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowRight />
        </Button>
      </div>
    </div>
  )
}
