import { lazy, Suspense, useEffect } from 'react'
import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { AppSidebar } from '@/components/app-sidebar'
import { EventsBridge } from '@/components/events-bridge'
import { NoProviderBanner } from '@/components/no-provider-banner'
import { SettingsDialog } from '@/components/settings-dialog'
import { ToolsPopover } from '@/components/tools-popover'
import { Button } from '@/components/ui/button'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { useLoadSessions } from '@/hooks/use-tasks'

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

  return (
    <>
      {/* Mounted always: owns event subscription + main→renderer
          navigation (incl. swarm:navigate-settings). Must never unmount. */}
      <EventsBridge />
      <SettingsDialog />
      {/* The whole window backdrop is the conversation surface (--window-content);
          the floating sidebar card sits on it, so the gap around the card matches
          the chat area instead of showing raw desktop vibrancy. */}
      <SidebarProvider className="bg-[var(--window-content)]">
        <TopBar />
        <AppSidebar />
        <SidebarInset className="min-w-0 overflow-hidden">
          <main className="flex h-svh flex-col overflow-hidden pt-9">
            <NoProviderBanner />
            <div className="min-h-0 flex-1">
              <Outlet />
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
      {SHOW_ROUTER_DEVTOOLS && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
  )
}

// Fixed, transparent control strip pinned to the window's top edge. It carries
// no background (no visible title bar) — only the window controls, vertically
// aligned with the native macOS traffic lights. Living here (outside the
// floating sidebar card) keeps the sidebar toggle reachable even when the
// sidebar is collapsed, and on the same row as the traffic lights.
function TopBar(): React.JSX.Element {
  const router = useRouter()
  return (
    <div
      className="fixed inset-x-0 top-0 z-30 flex h-9 shrink-0 items-center gap-0.5 px-2 pt-4"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left cluster, offset clear of the traffic lights. no-drag so the
          buttons stay clickable; the rest of the strip drags the window. */}
      <div
        className="flex items-center gap-0.5 pl-[88px]"
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
      {/* Right cluster: global tools/skills/MCP toggle. */}
      <div className="ml-auto flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <ToolsPopover />
      </div>
    </div>
  )
}
