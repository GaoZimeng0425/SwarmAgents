export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type TerminalRun = { runId: string; status: TerminalStatus }

export type TerminalRegistry = {
  isTerminal(runId: string): boolean
  getStatus(runId: string): TerminalStatus | undefined
  /** Record a terminal status. Idempotent — the FIRST terminal status wins and
   *  fires the listener exactly once per runId (so dual-firing during the
   *  updateTaskStatus→emit-path transition can't double-wake a waiter). */
  markTerminal(runId: string, status: TerminalStatus): void
  onTerminal(cb: (runId: string, status: TerminalStatus) => void): void
}

export function createTerminalRegistry(initial: Iterable<TerminalRun>): TerminalRegistry {
  const terminal = new Map<string, TerminalStatus>()
  for (const { runId, status } of initial) terminal.set(runId, status)
  let listener: ((runId: string, status: TerminalStatus) => void) | null = null
  return {
    isTerminal: (runId) => terminal.has(runId),
    getStatus: (runId) => terminal.get(runId),
    markTerminal: (runId, status) => {
      if (terminal.has(runId)) return
      terminal.set(runId, status)
      listener?.(runId, status)
    },
    onTerminal: (cb) => {
      listener = cb
    },
  }
}
