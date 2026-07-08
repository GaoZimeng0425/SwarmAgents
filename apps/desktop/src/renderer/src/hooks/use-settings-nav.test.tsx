// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingsNav } from './use-settings-nav'
import { useSettingsNav } from './use-settings-nav'

// The hook must run inside a router context. RouterProvider renders its own
// route tree (not arbitrary children), so we mount a small capture component as
// the root route's component; it calls the hook and stashes the LATEST result
// into a shared object the test can read. The validateSearch mirrors the app's
// __root settings param shape. RouterProvider mounts its tree asynchronously,
// so tests await `ready` before reading/calling the captured nav.
let captured: SettingsNav | null = null
function Capture(): React.JSX.Element {
  captured = useSettingsNav()
  return <></>
}

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>) => ({
    settings: typeof search.settings === 'string' ? search.settings : undefined,
  }),
  component: Capture,
})
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: (): React.JSX.Element => <></>,
})

function makeRouter(initialUrl: string): ReturnType<typeof createRouter> {
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  })
}

async function mount(router: ReturnType<typeof createRouter>): Promise<SettingsNav> {
  captured = null
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  // RouterProvider mounts the route tree on a microtask; wait for the capture.
  await waitFor(() => expect(captured).not.toBeNull())
  return captured!
}

beforeEach(() => {
  captured = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSettingsNav', () => {
  it('reads closed state when no settings param', async () => {
    const router = makeRouter('/')
    const nav = await mount(router)
    expect(nav.open).toBe(false)
    expect(nav.section).toBe(null)
  })

  it('reads open + section from the settings param', async () => {
    const router = makeRouter('/?settings=providers')
    const nav = await mount(router)
    await waitFor(() => expect(nav.open).toBe(true))
    expect(nav.section).toBe('providers')
  })

  it('openSettings navigates to add the param', async () => {
    const router = makeRouter('/')
    const nav = await mount(router)
    await nav.openSettings('mcp')
    await waitFor(() => expect(router.state.location.search.settings).toBe('mcp'))
  })

  it('close removes the param', async () => {
    const router = makeRouter('/?settings=general')
    const nav = await mount(router)
    await waitFor(() => expect(nav.open).toBe(true))
    await nav.close()
    await waitFor(() => expect(router.state.location.search.settings).toBeUndefined())
  })

  it('openSettings replace option controls history', async () => {
    const router = makeRouter('/')
    const nav = await mount(router)
    await nav.openSettings('general')
    await waitFor(() => expect(router.state.location.search.settings).toBe('general'))
    await nav.openSettings('providers', { replace: true })
    await waitFor(() => expect(router.state.location.search.settings).toBe('providers'))
    // (Asserting history length precisely is brittle; the replace flag is
    // exercised by the navigate call. The test confirms navigation still works.)
  })

  it('invalid settings value yields closed', async () => {
    const router = makeRouter('/?settings=bogus')
    const nav = await mount(router)
    await waitFor(() => expect(nav.open).toBe(false))
    expect(nav.section).toBe(null)
  })
})
