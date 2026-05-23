import { fork } from 'node:child_process'

import type { SpawnOptions, WorkerHandle, WorkerSpawner } from './spawner'

export function createNodeForkSpawner(): WorkerSpawner {
  return {
    spawn(opts: SpawnOptions): WorkerHandle {
      const child = fork(opts.entry, [], {
        env: { ...process.env, SWARM_WORKER_ID: opts.workerId, ...opts.env },
        serialization: 'advanced',
        silent: false,
      })
      const messageCbs: Array<(m: unknown) => void> = []
      const exitCbs: Array<(code: number | null) => void> = []
      child.on('message', (m) => {
        for (const cb of messageCbs) cb(m)
      })
      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => {
          for (const cb of exitCbs) cb(code)
          resolve(code)
        })
      })
      return {
        workerId: opts.workerId,
        send: (m) => child.send(m as any),
        onMessage: (cb) => {
          messageCbs.push(cb)
        },
        onExit: (cb) => {
          exitCbs.push(cb)
        },
        kill: () => {
          child.kill('SIGTERM')
        },
        exited,
      }
    },
  }
}
