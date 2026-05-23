export type SpawnOptions = {
  entry: string // absolute path to worker entry file
  workerId: string
  env?: Record<string, string>
}

export type WorkerHandle = {
  workerId: string
  send: (msg: unknown) => void
  onMessage: (cb: (msg: unknown) => void) => void
  onExit: (cb: (code: number | null) => void) => void
  kill: () => void
  exited: Promise<number | null>
}

export type WorkerSpawner = {
  spawn(opts: SpawnOptions): WorkerHandle
}
