import { lazy, Suspense, useEffect } from 'react'
import { SidebarInset, SidebarProvider, Toaster } from '@swarm/ui'
import { createRootRoute, Outlet, useMatches } from '@tanstack/react-router'

import { AppRail } from '@/components/app-rail'
import { EventsBridge } from '@/components/events-bridge'
import { NoProviderBanner } from '@/components/no-provider-banner'
import { SessionSearchDialog } from '@/components/session-search-dialog'
import { SettingsDialog } from '@/components/settings-dialog'
import { TitleBar } from '@/components/title-bar'
import { useAnalysisEventBridge } from '@/hooks/use-analysis-event-bridge'
import { useLoadSessions } from '@/hooks/use-messages'
import { isValidSection, type SettingsSection } from '@/stores/settings-dialog'

// Opt-in only — devtools overlap the UI and interfere with manual/automated UI
// testing. Enable with `VITE_ROUTER_DEVTOOLS=true pnpm dev`.
const SHOW_ROUTER_DEVTOOLS = import.meta.env.DEV && import.meta.env.VITE_ROUTER_DEVTOOLS === 'true'

const RouterDevtools = SHOW_ROUTER_DEVTOOLS
  ? lazy(() => import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })))
  : (): null => null

export const Route = createRootRoute({
  component: RootLayout,
  // `?settings=<section>` drives the settings modal. Declared on __root so it
  // works from any route. Hand-written validateSearch (not zod), matching the
  // style of session.$sessionId.tsx. Unknown/absent values close the modal.
  validateSearch: (search: Record<string, unknown>): { settings?: SettingsSection } => ({
    settings: isValidSection(search.settings) ? search.settings : undefined,
  }),
})

function RootLayout(): React.JSX.Element {
  const loadSessions = useLoadSessions()
  const matches = useMatches()
  const isQuickPanel = matches.some((m) => m.routeId === '/quick-panel')
  // Global analysis-stream subscription: dispatches the four flows' streaming
  // events into the analysis-stream store so state survives panel switches
  // (the "切走丢失" fix). Main window only — quick-panel has no analysis panels.
  useAnalysisEventBridge(!isQuickPanel)
  // Load the session list once at the root; the /session layout mounts the
  // SessionPanel, but the query cache persists across its mount/unmount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; loadSessions is a stable React Query mutation
  useEffect(() => {
    loadSessions.mutate()
  }, [])

  // The quick-panel route is a frameless floating window — skip the main-window
  // chrome (TitleBar / AppRail / Sidebar / SettingsDialog / SessionSearchDialog).
  // EventsBridge is mounted inside the route component itself so swarm:event
  // subscriptions work.
  if (isQuickPanel) {
    return <Outlet />
  }

  return (
    <>
      {/* Mounted always: owns event subscription + main→renderer
          navigation (incl. swarm:navigate-settings). Must never unmount. */}
      <EventsBridge />
      {/* Full-width transparent drag strip pinned to the very top edge; carries
          window drag everywhere the per-view topbars don't. Interactive controls
          in the top band opt out with `WebkitAppRegion: 'no-drag'`. */}
      <TitleBar />
      <SettingsDialog />
      <SessionSearchDialog />
      {/* The whole window backdrop is the conversation surface (--window-content);
          the rail + (conditionally) the session panel + the main inset sit on it. */}
      <SidebarProvider className="bg-(--window-content)">
        <AppRail />
        <SidebarInset className="min-w-0 flex-1 overflow-hidden">
          <main className="flex h-svh flex-col overflow-hidden">
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
