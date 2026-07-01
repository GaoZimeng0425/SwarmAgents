import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceClient, type ServiceTransport } from '@swarm/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startWsHost } from './index'

// Fake service sidecar: receives requests via postMessage, emits a canned
// response for 'listAgents'.
function fakeServiceProcess(): ServiceTransport & { emit: (m: unknown) => void } {
  const bus = new EventEmitter()
  const proc = {
    postMessage: (m: unknown) => {
      const req = m as { id: number; method: string }
      bus.emit('message', { kind: 'response', id: req.id, ok: true, result: { agents: ['ceo', 'worker'] } })
    },
    on: (_ch: 'message', fn: (m: unknown) => void) => bus.on('message', fn),
    off: (_ch: 'message', fn: (m: unknown) => void) => bus.off('message', fn),
    emit: (m: unknown) => bus.emit('message', m),
  }
  return proc as ServiceTransport & { emit: (m: unknown) => void }
}

// A WS transport that satisfies @swarm/protocol's ServiceTransport interface
// (used by the external client — exactly what the extension/RN will build).
function wsTransport(ws: WebSocket): ServiceTransport {
  return {
    postMessage: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (_ch: 'message', fn: (m: unknown) => void) => ws.on('message', (raw) => fn(JSON.parse(raw.toString()))),
    off: () => {}, // ws is short-lived for the test; not needed
  }
}

describe('startWsHost (loopback integration)', () => {
  let dir: string
  let dispose: () => void
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-host-e2e-'))
  })
  afterEach(() => {
    try {
      dispose()
    } catch {
      /* noop */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('an external ServiceClient over WS can call listAgents and get the service response', async () => {
    const serviceProcess = fakeServiceProcess()
    const host = await startWsHost({ serviceProcess, userDataDir: dir, log: console })
    dispose = host.dispose

    const ws = new WebSocket(`ws://127.0.0.1:${host.port}`, `swarm.${host.token}`)
    await new Promise((res, rej) => {
      ws.once('open', res)
      ws.once('error', rej)
    })
    const client = createServiceClient({ transport: wsTransport(ws) })
    await client.connect()
    const result = await client.listAgents()
    expect((result as unknown as { agents: unknown[] }).agents).toEqual(['ceo', 'worker'])
    client.disconnect()
    ws.close()
  })
})
