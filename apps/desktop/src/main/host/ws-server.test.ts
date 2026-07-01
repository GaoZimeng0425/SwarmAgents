import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startWsServer } from './ws-server'

describe('ws server', () => {
  // Each test starts its own server on port 0 (OS-assigned) and closes it in finally.

  it('accepts a peer with the correct subprotocol token', async () => {
    let connected = false
    const r = await startWsServer({
      port: 0,
      token: 'tok',
      onPeer: () => {
        connected = true
      },
      log: console,
    })
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.tok')
      await new Promise((res, rej) => {
        ws.once('open', res)
        ws.once('error', rej)
      })
      expect(connected).toBe(true)
      ws.close()
    } finally {
      r.close()
    }
  })

  it('rejects a peer with the wrong token (close 1008)', async () => {
    const r = await startWsServer({ port: 0, token: 'tok', onPeer: () => {}, log: console })
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.wrong')
      const code = await new Promise<number>((res) => ws.once('close', (c) => res(c)))
      expect(code).toBe(1008)
    } finally {
      r.close()
    }
  })

  it('rejects a second peer while one is connected', async () => {
    const r = await startWsServer({ port: 0, token: 'tok', onPeer: () => {}, log: console })
    try {
      const first = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.tok')
      await new Promise((res, rej) => {
        first.once('open', res)
        first.once('error', rej)
      })
      const second = new WebSocket(`ws://127.0.0.1:${r.port}`, 'swarm.tok')
      const code = await new Promise<number>((res) => second.once('close', (c) => res(c)))
      expect(code).toBe(1008)
      first.close()
    } finally {
      r.close()
    }
  })
})
