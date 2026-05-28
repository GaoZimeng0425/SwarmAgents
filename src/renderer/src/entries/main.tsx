import '../styles/globals.css'

import type React from 'react'
import { StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createHashHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { createRoot } from 'react-dom/client'

import { NoProviderBanner } from '@/components/no-provider-banner'
import { TooltipProvider } from '@/components/ui/tooltip'
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
  return (
    <div className="flex h-full flex-col">
      <NoProviderBanner />
      <div className="min-h-0 flex-1">
        <RouterProvider router={router} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange enableSystem>
        <TooltipProvider>
          <AccentBridge />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
)
