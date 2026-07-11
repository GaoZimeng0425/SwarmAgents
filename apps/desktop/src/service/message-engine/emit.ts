import { createLogger } from '@shared/logger'
import { type MessageWireEvent, type TerminalStatus, terminalStatusForMessageEvent } from '@swarm/protocol'

const log = createLogger({ process: 'service' }).child({ component: 'message-emit' })

// Omit that distributes over a union (plain Omit collapses union members).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A message.* event as authored at a call site — identity/ordering fields are
 *  stamped here, exactly once. */
export type MessageEmitInput = DistributiveOmit<
  MessageWireEvent,
  'sessionId' | 'messageId' | 'parentMessageId' | 'seq' | 'ts'
>

export type MessageEmit = (input: MessageEmitInput) => void

/** Ports bound by the launch layer (W3: seq-counter, message_events store,
 *  terminal registry, broadcaster) or by out-of-session callers like
 *  gmail-analyze with their own sinks. */
export type MessageEmitPorts = {
  nextSeq(sessionId: string): number
  appendEvent(evt: MessageWireEvent): void
  markTerminal(messageId: string, status: TerminalStatus): void
  broadcast(evt: MessageWireEvent): void
}

export type MessageIdentity = { sessionId: string; messageId: string; parentMessageId?: string }

/**
 * The ONE emit path for a message (spec §3): stamps identity + seq + ts, persists,
 * marks the first-wins terminal registry, broadcasts. Unlike the v1 factory it
 * has a single identity mode (no payload sniffing) and never mutates caller
 * objects (ledger #13) — the inner progress event is cloned to carry its seq.
 */
export function createMessageEmit(ports: MessageEmitPorts, ids: MessageIdentity): MessageEmit {
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
      messageId: ids.messageId,
      ...(ids.parentMessageId !== undefined ? { parentMessageId: ids.parentMessageId } : {}),
      seq,
      ts,
    } as MessageWireEvent
    ports.appendEvent(evt)
    const term = terminalStatusForMessageEvent(evt)
    if (term) ports.markTerminal(ids.messageId, term)
    // Persistence already succeeded; a throwing broadcaster (e.g. a dead IPC
    // sink) must NOT reject the engine and trigger launch's synthetic second
    // terminal row. Log-only (W2 final-review Minor #3).
    try {
      ports.broadcast(evt)
    } catch (err) {
      log.error({
        msg: 'broadcast failed',
        kind: evt.kind,
        sessionId: ids.sessionId,
        messageId: ids.messageId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
