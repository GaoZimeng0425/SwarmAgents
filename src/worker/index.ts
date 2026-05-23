import { InboundSchema, type Outbound } from '@shared/types/ipc'
import { createLogger } from '@shared/logger'
import { handleInbound } from './handler'

const log = createLogger({ process: 'worker', workerId: process.env.SWARM_WORKER_ID ?? 'unknown' })

type WorkerPort = {
  postMessage: (m: unknown) => void
  start?: () => void
  addEventListener?: (e: 'message', cb: (e: MessageEvent) => void) => void
}

let activePort: WorkerPort | null = null

const send = (m: Outbound): void => {
  if (activePort) {
    activePort.postMessage(m)
    return
  }
  if (typeof process.send === 'function') {
    process.send(m)
    return
  }
  log.warn({ msg: 'no transport available to send outbound', payload: m })
}

const onMessage = (raw: unknown): void => {
  const parsed = InboundSchema.safeParse(raw)
  if (!parsed.success) {
    log.warn({ msg: 'invalid inbound message', issues: parsed.error.issues })
    return
  }
  handleInbound(parsed.data, send)
}

type ParentPort = {
  on: (e: 'message', cb: (m: { data: unknown; ports?: WorkerPort[] }) => void) => void
}
const parentPort: ParentPort | undefined =
  (process as unknown as { parentPort?: ParentPort }).parentPort

if (parentPort) {
  parentPort.on('message', (e) => {
    if (!activePort && e.ports?.[0]) {
      const p = e.ports[0]
      activePort = p
      p.addEventListener?.('message', (evt: MessageEvent) => onMessage(evt.data))
      p.start?.()
      return
    }
    onMessage(e.data)
  })
} else if (typeof process.on === 'function') {
  process.on('message', onMessage)
}

setInterval(() => send({ type: 'heartbeat', ts: Date.now() }), 5_000).unref()

log.info('worker ready')
