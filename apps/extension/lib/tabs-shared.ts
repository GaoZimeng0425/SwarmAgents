// Types and message-type constants shared between the background SW (which owns
// tabs state) and the side-panel TabsTab (which renders it). Pure declarations
// — no runtime logic, so both sides import without circular deps.

// A slim projection of chrome.tabs.Tab — only what the view/debug needs.
export type TabInfo = {
  id: number
  windowId: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean // whether this tab is the active tab of its window
}

// Tabs grouped by window, the shape the UI renders.
export type WindowTabs = {
  windowId: number
  incognito: boolean // retained; always false in v1 (no incognito access)
  tabs: TabInfo[]
}

// runtime.sendMessage message types (the `type` field routes them).
export const TABS_MSG = {
  getSnapshot: 'tabs:getSnapshot',
  snapshot: 'tabs:snapshot',
  changed: 'tabs:changed',
  snapshotError: 'tabs:snapshotError',
} as const

export type TabsChangedKind = 'created' | 'updated' | 'removed' | 'attached' | 'activated'

// The delta pushed to the panel on each tabs.on* event.
export type TabsChangedMessage = {
  type: typeof TABS_MSG.changed
  kind: TabsChangedKind
  tab: TabInfo
}

// The response to a `tabs:getSnapshot` request. Either the projected
// WindowTabs[] plus the raw chrome.tabs.Tab[] (for the RawJson debug surface,
// spec §7.3) on success, or an error string on failure.
export type TabsSnapshotResponse =
  | { type: typeof TABS_MSG.snapshot; windows: WindowTabs[]; raw: chrome.tabs.Tab[] }
  | { type: typeof TABS_MSG.snapshotError; error: string }
