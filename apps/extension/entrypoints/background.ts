/// <reference types="chrome" />
import { createServiceClient, type ServiceClient } from '@swarm/protocol'

import { TABS_MSG, type TabInfo, type TabsChangedKind, type WindowTabs } from '../lib/tabs-shared'
import { createTabsStore } from '../lib/tabs-store'
import { createWsTransport } from '../lib/transport-ws'

type HostConfig = { wsHost: string; token: string }

async function loadConfig(): Promise<HostConfig> {
  const { wsHost, token } = await browser.storage.local.get(['wsHost', 'token'])
  return {
    wsHost: (wsHost as string) || 'ws://127.0.0.1:47777',
    token: (token as string) || '',
  }
}

let client: ServiceClient | null = null
let activeWs: WebSocket | null = null

async function connect(): Promise<void> {
  const { wsHost, token } = await loadConfig()
  if (!token) {
    console.warn('[swarm-ext] no token — set it in Options')
    return
  }
  if (activeWs) {
    try {
      activeWs.close()
    } catch {
      /* noop */
    }
  }
  const ws = new WebSocket(wsHost, `swarm.${token}`)
  activeWs = ws
  ws.addEventListener('close', () => {
    console.warn('[swarm-ext] ws closed — will retry on next alarm')
    client = null
    activeWs = null
  })
  const { transport, ready } = createWsTransport(ws)
  await ready
  client = createServiceClient({
    transport,
    onEvent: (e, d) => console.log('[swarm-ext] event', e, d),
  })
  await client.connect()
  console.log('[swarm-ext] connected to', wsHost)
}

export default defineBackground(() => {
  // MV3 service workers are killed after ~30s idle. A periodic alarm both
  // wakes the worker and drives reconnect attempts when the WS has dropped.
  browser.alarms.create('swarm-keepalive', { periodInMinutes: 0.5 })
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'swarm-keepalive' && !activeWs) void connect()
  })

  browser.runtime.onInstalled.addListener(() => {
    void connect()
  })
  browser.runtime.onStartup.addListener(() => {
    void connect()
  })
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.wsHost || changes.token)) void connect()
  })

  // Clicking the toolbar icon opens the side panel. With no popup entrypoint,
  // action.onClicked fires; chrome.sidePanel.open must be called from a user
  // gesture, and onClicked is one. (Path is the sidepanel entrypoint's, set in
  // manifest.side_panel.default_path by WXT.)
  browser.action.onClicked.addListener((tab) => {
    void chrome.sidePanel.open({ windowId: tab.windowId })
  })

  // --- Tabs store (lazy-initialized on first tabs:getSnapshot request).
  // The store registers its own chrome.tabs.on* listeners inside the factory.
  let tabsStore: ReturnType<typeof createTabsStore> | null = null
  let tabsListening = false // true while a panel wants live deltas

  function getTabsStore() {
    if (!tabsStore) {
      tabsStore = createTabsStore({ tabs: chrome.tabs })
      // While at least one panel is listening, forward each delta. The store's
      // on* handlers already mutated state by the time we'd want to read it,
      // so we re-listen here purely to broadcast. (Listener order: the store
      // registered its listeners in createTabsStore; these fire after.)
      const emit = (kind: TabsChangedKind, tab: chrome.tabs.Tab) => {
        if (!tabsListening) return
        const info: TabInfo = {
          id: tab.id ?? -1,
          windowId: tab.windowId,
          title: tab.title ?? '',
          url: tab.url ?? '',
          favIconUrl: tab.favIconUrl,
          active: tab.active ?? false,
        }
        browser.runtime.sendMessage({ type: TABS_MSG.changed, kind, tab: info }).catch(() => {
          /* panel may be closed; ignore */
        })
      }
      chrome.tabs.onCreated.addListener((tab) => emit('created', tab))
      chrome.tabs.onUpdated.addListener((_id, _info, tab) => emit('updated', tab))
      chrome.tabs.onRemoved.addListener((id) => {
        if (!tabsListening) return
        // onRemoved gives no full Tab; emit a minimal tombstone.
        browser.runtime
          .sendMessage({
            type: TABS_MSG.changed,
            kind: 'removed',
            tab: { id, windowId: -1, title: '', url: '', active: false },
          })
          .catch(() => {})
      })
      chrome.tabs.onActivated.addListener((info) => {
        if (!tabsListening) return
        chrome.tabs
          .get(info.tabId)
          .then((tab) => emit('activated', tab))
          .catch(() => {})
      })
      // attached — tab dragged to a different window. onAttached gives only
      // (tabId, {newWindowId, newPosition}); re-fetch the tab to get full info
      // (title/url/active) before broadcasting. The store's own onAttached
      // listener already moved the record; this broadcast is what refreshes
      // the panel.
      chrome.tabs.onAttached.addListener((tabId) => {
        if (!tabsListening) return
        chrome.tabs
          .get(tabId)
          .then((tab) => emit('attached', tab))
          .catch(() => {})
      })
    }
    return tabsStore
  }

  // The side panel probes connectivity via `health` (no provider/secret
  // needed — submitPrompt needs a ProviderInjection the extension doesn't own).
  // listAgents is kept for backward compatibility; health wraps the same probe.
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if ((msg as { type?: string })?.type === 'health') {
      ;(async () => {
        if (!client) {
          sendResponse({ ok: false, error: 'not connected' })
          return
        }
        try {
          const agents = await client.listAgents()
          sendResponse({ ok: true, count: agents.length })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // async response
    }
    if ((msg as { type?: string })?.type === 'listAgents' && client) {
      ;(async () => {
        try {
          const agents = await client.listAgents()
          sendResponse({ ok: true, count: agents.length })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // async response
    }
    if ((msg as { type?: string })?.type === 'collectCurrentPage' && client) {
      ;(async () => {
        try {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
          if (!tab.id) {
            sendResponse({ ok: false, error: 'no active tab' })
            return
          }
          // Actively inject the extract content script. This is idempotent
          // (re-injecting is fine) and ensures the `extract` listener exists
          // even on tabs opened before the extension loaded — which the
          // static content_scripts registration would miss, causing
          // "Receiving end does not exist" on sendMessage.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-scripts/extract.js'],
            })
          } catch (injErr) {
            sendResponse({ ok: false, error: `注入脚本失败:${String(injErr)}` })
            return
          }
          const input = await browser.tabs.sendMessage(tab.id, { type: 'extract' })
          if (!input) {
            sendResponse({ ok: false, error: '抽取失败(非文章页?)' })
            return
          }
          const res = await client.collectArticle(input)
          if (res.ok) sendResponse({ ok: true, articleId: res.articleId })
          else sendResponse({ ok: false, error: res.message })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // async response
    }
    if ((msg as { type?: string })?.type === TABS_MSG.getSnapshot) {
      ;(async () => {
        try {
          const store = getTabsStore()
          await store.loadAll()
          tabsListening = true
          const windows: WindowTabs[] = store.snapshot()
          sendResponse({ type: TABS_MSG.snapshot, windows, raw: store.rawSnapshot() })
        } catch (err) {
          sendResponse({ type: TABS_MSG.snapshotError, error: String(err) })
        }
      })()
      return true
    }
    return false
  })
})
