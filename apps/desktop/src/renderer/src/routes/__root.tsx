import { lazy, Suspense, useEffect } from 'react'
import { Button, SidebarInset, SidebarProvider, Toaster } from '@swarm/ui'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { AppRail } from '@/components/app-rail'
import { EventsBridge } from '@/components/events-bridge'
import { NoProviderBanner } from '@/components/no-provider-banner'
import { isConversationScene } from '@/components/rail-config'
import { SessionPanel } from '@/components/session-panel'
import { SessionSearchDialog } from '@/components/session-search-dialog'
import { SettingsDialog } from '@/components/settings-dialog'
import { ToolsPopover } from '@/components/tools-popover'
import { useLoadSessions } from '@/hooks/use-runs'

// Opt-in only — devtools overlap the UI and interfere with manual/automated UI
// testing. Enable with `VITE_ROUTER_DEVTOOLS=true pnpm dev`.
const SHOW_ROUTER_DEVTOOLS = import.meta.env.DEV && import.meta.env.VITE_ROUTER_DEVTOOLS === 'true'

const RouterDevtools = SHOW_ROUTER_DEVTOOLS
  ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })))
  : (): null => null

export const Route = createRootRoute({ component: RootLayout })

function RootLayout(): React.JSX.Element {
  const loadSessions = useLoadSessions()
  const location = useLocation()
  // Load the session list once at the root; the SessionPanel is conditionally
  // mounted per scene, but the query cache persists across its mount/unmount.
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
      <SessionSearchDialog />
      {/* The whole window backdrop is the conversation surface (--window-content);
          the rail + (conditionally) the session panel + the main inset sit on it. */}
      <SidebarProvider className="bg-(--window-content)">
        <TopBar />
        <AppRail />
        {isConversationScene(location.pathname) && <SessionPanel />}
        <SidebarInset className="min-w-0 flex-1 overflow-hidden">
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
// no background (no visible title bar) — only the back/forward controls and the
// global tools cluster, vertically aligned with the native macOS traffic lights.
// Living outside the rail/panel keeps it on the same row as the traffic lights
// regardless of which scene is active.
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
