import { lazy, Suspense, useEffect } from 'react'
import { SidebarInset, SidebarProvider, Toaster } from '@swarm/ui'
import { createRootRoute, Outlet, useLocation } from '@tanstack/react-router'

import { AppRail } from '@/components/app-rail'
import { EventsBridge } from '@/components/events-bridge'
import { NoProviderBanner } from '@/components/no-provider-banner'
import { isConversationScene } from '@/components/rail-config'
import { SessionPanel } from '@/components/session-panel'
import { SessionSearchDialog } from '@/components/session-search-dialog'
import { SettingsDialog } from '@/components/settings-dialog'
import { useLoadSessions } from '@/hooks/use-runs'
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
        <AppRail />
        {isConversationScene(location.pathname) && <SessionPanel />}
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
