import { describe, expect, it } from 'vitest'

import { createTabsStore } from './tabs-store'

// The chrome.tabs shape createTabsStore expects. The brief casts the fake via
// `as unknown as typeof chrome`, but the local `const chrome` returned by
// fakeChrome shadows the global, so we alias the store's parameter type and
// cast to it instead — same intent, typechecks cleanly.
type ChromeApi = Parameters<typeof createTabsStore>[0]

// Fake chrome.tabs for unit testing. The store calls chrome.tabs.query and
// registers on* listeners; we capture both. We type this as `unknown` then
// cast at the call site so the test does not pull in the full @types/chrome
// surface beyond what the store uses.
type Tab = {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
  active?: boolean
  incognito?: boolean
}

function fakeChrome(initialTabs: Tab[]) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  // Capture each on* listener into handlers[key]; split into statements so we
  // don't rely on assignment-in-expression (biome: noAssignInExpressions).
  const capture = (key: string) => (fn: (...a: unknown[]) => void) => {
    if (!handlers[key]) handlers[key] = []
    handlers[key].push(fn)
  }
  const chrome = {
    tabs: {
      query: async () => initialTabs.map((t) => ({ ...t })),
      onCreated: { addListener: capture('onCreated') },
      onUpdated: { addListener: capture('onUpdated') },
      onRemoved: { addListener: capture('onRemoved') },
      onAttached: { addListener: capture('onAttached') },
      onActivated: { addListener: capture('onActivated') },
    },
  }
  return { chrome, handlers }
}

describe('createTabsStore', () => {
  it('loadAll produces a snapshot grouped by window with active flags', async () => {
    const { chrome } = fakeChrome([
      { id: 1, windowId: 10, title: 'A', url: 'https://a.com', active: true },
      { id: 2, windowId: 10, title: 'B', url: 'https://b.com', active: false },
      { id: 3, windowId: 20, title: 'C', url: 'https://c.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    await store.loadAll()
    const snap = store.snapshot()
    expect(snap).toHaveLength(2)
    const w10 = snap.find((w) => w.windowId === 10)!
    expect(w10.tabs).toHaveLength(2)
    expect(w10.tabs[0].active).toBe(true)
    expect(w10.tabs[1].active).toBe(false)
  })

  it('applyCreated adds a tab into its window group', async () => {
    const { chrome, handlers } = fakeChrome([])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    await store.loadAll()
    expect(store.snapshot()).toHaveLength(0)

    // Simulate tabs.onCreated firing.
    handlers.onCreated[0]({ id: 5, windowId: 10, title: 'New', url: 'https://n.com', active: false })
    const snap = store.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].windowId).toBe(10)
    expect(snap[0].tabs[0].id).toBe(5)
  })

  it('applyUpdated merges changeInfo into an existing tab', async () => {
    const { chrome, handlers } = fakeChrome([
      { id: 1, windowId: 10, title: 'Old', url: 'https://old.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    await store.loadAll()

    handlers.onUpdated[0](
      1,
      { title: 'New' },
      { id: 1, windowId: 10, title: 'New', url: 'https://old.com', active: true }
    )
    const tab = store.snapshot()[0].tabs[0]
    expect(tab.title).toBe('New')
    expect(tab.url).toBe('https://old.com')
  })

  it('applyRemoved deletes a tab and drops the window if empty', async () => {
    const { chrome, handlers } = fakeChrome([
      { id: 1, windowId: 10, title: 'Only', url: 'https://o.com', active: true },
    ])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    await store.loadAll()

    handlers.onRemoved[0](1, { windowId: 10, isWindowClosing: false })
    expect(store.snapshot()).toHaveLength(0)
  })

  it('applyActivated flips active flags within a window', async () => {
    const { chrome, handlers } = fakeChrome([
      { id: 1, windowId: 10, title: 'A', url: 'https://a.com', active: true },
      { id: 2, windowId: 10, title: 'B', url: 'https://b.com', active: false },
    ])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    await store.loadAll()

    handlers.onActivated[0]({ tabId: 2, windowId: 10 })
    const tabs = store.snapshot()[0].tabs
    expect(tabs.find((t) => t.id === 1)!.active).toBe(false)
    expect(tabs.find((t) => t.id === 2)!.active).toBe(true)
  })

  it('snapshot is empty before loadAll (lazy init)', () => {
    const { chrome } = fakeChrome([])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    expect(store.snapshot()).toEqual([])
  })

  it('re-loadAll after a simulated SW restart yields a fresh snapshot', async () => {
    const { chrome } = fakeChrome([{ id: 1, windowId: 10, title: 'A', url: 'https://a.com', active: true }])
    const store = createTabsStore(chrome as unknown as ChromeApi)
    await store.loadAll()
    expect(store.snapshot()).toHaveLength(1)

    // Simulate SW restart: a new store instance (in-memory state gone).
    const store2 = createTabsStore(chrome as unknown as ChromeApi)
    expect(store2.snapshot()).toEqual([]) // lazy, not yet loaded
    await store2.loadAll()
    expect(store2.snapshot()).toHaveLength(1)
  })
})
