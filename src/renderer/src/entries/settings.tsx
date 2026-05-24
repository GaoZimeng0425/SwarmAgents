// src/renderer/src/entries/settings.tsx
//
// Independent entry for the Settings BrowserWindow (spec §8). Uses its own
// TanStack Router instance with the settings route tree. Re-uses
// QueryClient + ThemeProvider but does NOT mount the EventsBridge — Settings
// is read-light and does not subscribe to task events.
import { QueryClientProvider } from '@tanstack/react-query'
import { createHashHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAccent } from '@/hooks/use-accent'
import { queryClient } from '@/lib/query-client'

import '../styles/globals.css'

import { routeTree } from '../routeTreeSettings.gen'

const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
})

// NOTE: The `Register` augmentation is intentionally omitted here.
// Task 25 will generate routeTreeSettings.gen.ts with a typed routeTree,
// at which point this entry gets its own Register block (or a shared one).

function SettingsApp(): React.JSX.Element {
  useAccent()
  return <RouterProvider router={router} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider>
          <SettingsApp />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
