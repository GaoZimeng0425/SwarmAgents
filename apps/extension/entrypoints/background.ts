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

async function connect(): Promise<void> {
  const { wsHost, token } = await loadConfig()
  if (!token) {
    console.warn('[swarm-ext] no token configured — set it in Options')
    return
  }
  const ws = new WebSocket(wsHost, `swarm.${token}`)
  const { transport, ready } = createWsTransport(ws)
  await ready
  client = createServiceClient({
    transport,
    onEvent: (event, data) => console.log('[swarm-ext] event', event, data),
  })
  await client.connect()
  console.log('[swarm-ext] connected to', wsHost)
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => { void connect() })
  browser.runtime.onStartup.addListener(() => { void connect() })
})
