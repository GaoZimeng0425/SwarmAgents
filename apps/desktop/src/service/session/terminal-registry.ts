export type TerminalStatus = 'completed' | 'failed' | 'cancelled'

export type TerminalMessage = { messageId: string; status: TerminalStatus }

export type TerminalRegistry = {
  isTerminal(messageId: string): boolean
  getStatus(messageId: string): TerminalStatus | undefined
  /** Record a terminal status. Idempotent — the FIRST terminal status wins. */
  markTerminal(messageId: string, status: TerminalStatus): void
}

export function createTerminalRegistry(initial: Iterable<TerminalMessage>): TerminalRegistry {
  const terminal = new Map<string, TerminalStatus>()
  for (const { messageId, status } of initial) terminal.set(messageId, status)
  return {
    isTerminal: (messageId) => terminal.has(messageId),
    getStatus: (messageId) => terminal.get(messageId),
    markTerminal: (messageId, status) => {
      if (terminal.has(messageId)) return
      terminal.set(messageId, status)
    },
  }
}
