// Background-side tabs state machine. The SW owns a single store instance:
// loadAll() pulls a full snapshot on first consumer request (lazy); the
// chrome.tabs.on* listeners (registered inside the factory) apply incremental
// deltas. snapshot() returns the current state grouped by window. Task 5 wires
// this into background.ts and bridges deltas to the panel.
import type { TabInfo, WindowTabs } from './tabs-shared'

export type TabsStore = {
  loadAll(): Promise<void>
  snapshot(): WindowTabs[]
}

export function createTabsStore(chromeApi: {
  tabs: {
    query(opts: Record<string, unknown>): Promise<chrome.tabs.Tab[]>
    onCreated: { addListener(fn: (tab: chrome.tabs.Tab) => void): void }
    onUpdated: { addListener(fn: (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void): void }
    onRemoved: { addListener(fn: (id: number, info: chrome.tabs.OnRemovedInfo) => void): void }
    onAttached: { addListener(fn: (id: number, info: chrome.tabs.OnAttachedInfo) => void): void }
    onActivated: { addListener(fn: (info: chrome.tabs.OnActivatedInfo) => void): void }
  }
}): TabsStore {
  const tabs = new Map<number, TabInfo>()
  const windows = new Map<number, { incognito: boolean }>()
  let loaded = false

  function toRecord(tab: chrome.tabs.Tab): TabInfo {
    return {
      // tab.id is optional in @types/chrome (undefined for app/devtools tabs);
      // fall back to -1 to satisfy TabInfo.id: number.
      id: tab.id ?? -1,
      windowId: tab.windowId,
      title: tab.title ?? '',
      url: tab.url ?? '',
      favIconUrl: tab.favIconUrl,
      active: tab.active ?? false,
    }
  }

  function upsert(rec: TabInfo): void {
    tabs.set(rec.id, rec)
    if (!windows.has(rec.windowId)) windows.set(rec.windowId, { incognito: false })
  }

  // created
  chromeApi.tabs.onCreated.addListener((tab) => {
    upsert(toRecord(tab))
  })

  // updated — merge changeInfo (title/url/favIconUrl) into the existing record.
  chromeApi.tabs.onUpdated.addListener((_id, info, tab) => {
    const existing = tabs.get(tab.id ?? -1)
    if (!existing) {
      upsert(toRecord(tab))
      return
    }
    existing.title = info.title ?? tab.title ?? existing.title
    existing.url = info.url ?? tab.url ?? existing.url
    if (info.favIconUrl !== undefined) existing.favIconUrl = info.favIconUrl
  })

  // removed
  chromeApi.tabs.onRemoved.addListener((id) => {
    tabs.delete(id)
  })

  // attached — tab moved to a different window
  chromeApi.tabs.onAttached.addListener((id, info) => {
    const rec = tabs.get(id)
    if (rec) {
      rec.windowId = info.newWindowId
      if (!windows.has(info.newWindowId)) windows.set(info.newWindowId, { incognito: false })
    }
  })

  // activated — flip active flags within the window
  chromeApi.tabs.onActivated.addListener((info) => {
    for (const rec of tabs.values()) {
      if (rec.windowId === info.windowId) rec.active = rec.id === info.tabId
    }
  })

  function rebuild(): void {
    const liveWindows = new Set<number>()
    for (const rec of tabs.values()) liveWindows.add(rec.windowId)
    for (const wid of windows.keys()) {
      if (!liveWindows.has(wid)) windows.delete(wid)
    }
  }

  return {
    async loadAll() {
      const all = await chromeApi.tabs.query({})
      tabs.clear()
      windows.clear()
      for (const tab of all) upsert(toRecord(tab))
      loaded = true
    },

    snapshot() {
      if (!loaded) return []
      rebuild()
      const byWindow = new Map<number, TabInfo[]>()
      for (const rec of tabs.values()) {
        const arr = byWindow.get(rec.windowId) ?? []
        arr.push(rec)
        byWindow.set(rec.windowId, arr)
      }
      const result: WindowTabs[] = []
      for (const [windowId, tabList] of byWindow) {
        const meta = windows.get(windowId) ?? { incognito: false }
        result.push({ windowId, incognito: meta.incognito, tabs: tabList })
      }
      return result
    },
  }
}
