import type { ServiceTransport } from '@swarm/protocol'

import { loadOrCreateHostConfig } from './auth'
import { attachBridge } from './bridge'
import { startWsServer } from './ws-server'

export type StartWsHost = {
  serviceProcess: ServiceTransport
  userDataDir: string
  log: { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void }
}

// Boot the agent-runtime WS host: load/create port+token, start the loopback
// server, and attach a bridge on each authenticated peer. Returns dispose().
export async function startWsHost(cfg: StartWsHost): Promise<{ port: number; token: string; dispose: () => void }> {
  const { port, token } = loadOrCreateHostConfig(cfg.userDataDir)
  const started = await startWsServer({
    port,
    token,
    log: cfg.log,
    onPeer: (peer) => {
      const detach = attachBridge({ peer, service: cfg.serviceProcess, log: cfg.log })
      peer.on('close', () => detach())
    },
  })
  cfg.log.info({ msg: 'ws-host started', port: started.port })
  return { port: started.port, token, dispose: started.close }
}
