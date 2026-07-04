import { type RunWireEvent, type TerminalStatus, terminalStatusForRunEvent } from '@swarm/protocol'

// Omit that distributes over a union (plain Omit collapses union members).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A run.* event as authored at a call site — identity/ordering fields are
 *  stamped here, exactly once. */
export type RunEmitInput = DistributiveOmit<RunWireEvent, 'sessionId' | 'runId' | 'parentRunId' | 'seq' | 'ts'>

export type RunEmit = (input: RunEmitInput) => void

/** Ports bound by the launch layer (W3: seq-counter, run_events store,
 *  terminal registry, broadcaster) or by out-of-session callers like
 *  gmail-analyze with their own sinks. */
export type RunEmitPorts = {
  nextSeq(sessionId: string): number
  appendEvent(evt: RunWireEvent): void
  markTerminal(runId: string, status: TerminalStatus): void
  broadcast(evt: RunWireEvent): void
}

export type RunIdentity = { sessionId: string; runId: string; parentRunId?: string }

/**
 * The ONE emit path for a run (spec §3): stamps identity + seq + ts, persists,
 * marks the first-wins terminal registry, broadcasts. Unlike the v1 factory it
 * has a single identity mode (no payload sniffing) and never mutates caller
 * objects (ledger #13) — the inner progress event is cloned to carry its seq.
 */
export function createRunEmit(ports: RunEmitPorts, ids: RunIdentity): RunEmit {
  return (input) => {
    const seq = ports.nextSeq(ids.sessionId)
    const ts = Date.now()
    const inner =
      'event' in input && input.event && typeof input.event === 'object'
        ? { event: { ...input.event, seq } }
        : undefined
    const evt = {
      ...input,
      ...(inner ?? {}),
      sessionId: ids.sessionId,
      runId: ids.runId,
      ...(ids.parentRunId !== undefined ? { parentRunId: ids.parentRunId } : {}),
      seq,
      ts,
    } as RunWireEvent
    ports.appendEvent(evt)
    const term = terminalStatusForRunEvent(evt)
    if (term) ports.markTerminal(ids.runId, term)
    ports.broadcast(evt)
  }
}
