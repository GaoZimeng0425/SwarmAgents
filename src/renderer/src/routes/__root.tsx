import { lazy, Suspense } from 'react'
import { createRootRoute, Outlet } from '@tanstack/react-router'

import { AppSidebar } from '@/components/app-sidebar'
import { EventsBridge } from '@/components/events-bridge'
import { TitleBar } from '@/components/title-bar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'

const RouterDevtools = import.meta.env.DEV
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
        <main className="h-full pt-7">
          <Outlet />
        </main>
      </SidebarInset>
      <Toaster />
      {import.meta.env.DEV && (
        <Suspense fallback={null}>
          <RouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </SidebarProvider>
  )
}
