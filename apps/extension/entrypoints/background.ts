import { createServiceClient, type ServiceClient } from '@swarm/protocol'

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

  // popup probes connectivity by listing agents (no provider/secret needed —
  // submitGoal needs a ProviderInjection the extension doesn't own; deferred).
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    return false
  })
})
