export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type TerminalRun = { runId: string; status: TerminalStatus }

export type TerminalRegistry = {
  isTerminal(runId: string): boolean
  getStatus(runId: string): TerminalStatus | undefined
  /** Record a terminal status. Idempotent — the FIRST terminal status wins. */
  markTerminal(runId: string, status: TerminalStatus): void
}

export function createTerminalRegistry(initial: Iterable<TerminalRun>): TerminalRegistry {
  const terminal = new Map<string, TerminalStatus>()
  for (const { runId, status } of initial) terminal.set(runId, status)
  return {
    isTerminal: (runId) => terminal.has(runId),
    getStatus: (runId) => terminal.get(runId),
    markTerminal: (runId, status) => {
      if (terminal.has(runId)) return
      terminal.set(runId, status)
    },
  }
}
