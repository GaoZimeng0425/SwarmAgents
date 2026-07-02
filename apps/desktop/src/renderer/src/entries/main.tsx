import '../styles/globals.css'

import type React from 'react'
import { StrictMode } from 'react'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { hotkeysDevtoolsPlugin } from '@tanstack/react-hotkeys-devtools'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools'
import { createHashHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { ThemeProvider } from 'next-themes'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@swarm/ui'
import { useAccent } from '@/hooks/use-accent'
import { queryClient } from '@/lib/query-client'
import { routeTree } from '../routeTree.gen'

const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

function AccentBridge(): React.JSX.Element {
  useAccent()
  return <RouterProvider router={router} />
}

// Dev-only: a single TanStack Devtools shell that folds the Router, Query, and
// Hotkeys panels into one floating trigger. Rendered inside QueryClientProvider
// so the Query panel sees the client; the Router panel takes the router
// explicitly. Gated on import.meta.env.DEV so it never shows in production.
function DevtoolsPanel(): React.JSX.Element | null {
  if (!import.meta.env.DEV) return null
  return (
    <TanStackDevtools
      plugins={[
        { name: 'TanStack Router', render: <TanStackRouterDevtoolsPanel router={router} /> },
        { name: 'TanStack Query', render: <ReactQueryDevtoolsPanel /> },
        hotkeysDevtoolsPlugin(),
      ]}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange enableSystem>
        <TooltipProvider>
          <AccentBridge />
          <DevtoolsPanel />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
)
