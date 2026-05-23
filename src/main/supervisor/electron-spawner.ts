import { utilityProcess, MessageChannelMain } from 'electron'
import type { SpawnOptions, WorkerHandle, WorkerSpawner } from './spawner'

export function createElectronSpawner(): WorkerSpawner {
  return {
    spawn(opts: SpawnOptions): WorkerHandle {
      const { port1, port2 } = new MessageChannelMain()
      const child = utilityProcess.fork(opts.entry, [], {
        serviceName: opts.workerId,
        env: { ...process.env, SWARM_WORKER_ID: opts.workerId, ...opts.env },
      })

      // Hand port2 to the child as its IPC transport.
      child.postMessage('init-port', [port2])

      const messageCbs: Array<(m: unknown) => void> = []
      const exitCbs: Array<(code: number | null) => void> = []
      port1.on('message', (e) => {
        for (const cb of messageCbs) cb(e.data)
      })
      port1.start()

      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => {
          for (const cb of exitCbs) cb(code)
          resolve(code)
        })
      })

      return {
        workerId: opts.workerId,
        send: (m) => port1.postMessage(m),
        onMessage: (cb) => {
          messageCbs.push(cb)
        },
        onExit: (cb) => {
          exitCbs.push(cb)
        },
        kill: () => {
          child.kill()
        },
        exited,
      }
    },
  }
}
