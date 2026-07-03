import type { Task } from '@swarm/protocol'

// Per-session monotonic seq counter. Lazily initializes from the max persisted
// seq so a resumed session continues past its history (no collision across
// service restarts). Centralized so makeEmit is the single seq-assignment point.
// The max is taken across BOTH task events and session-conversation events, so
// the two streams share one seq space and interleave in the transcript without
// collision.
export type SeqCounter = {
  nextSeq: (sessionId: string) => number
}

/** Minimal shape createSeqCounter reads from a session's conversation events. */
export type ConversationEventRow = { seq: number }

export function createSeqCounter(
  getSessionTasks: (sessionId: string) => Task[],
  getConversationEvents: (sessionId: string) => ConversationEventRow[] = () => []
): SeqCounter {
  const counters = new Map<string, number>()

  const initMax = (sessionId: string): number => {
    let max = 0
    for (const t of getSessionTasks(sessionId)) {
      for (const ev of t.history) {
        if (typeof ev.seq === 'number' && ev.seq > max) max = ev.seq
      }
    }
    for (const r of getConversationEvents(sessionId)) {
      if (typeof r.seq === 'number' && r.seq > max) max = r.seq
    }
    return max
  }

  return {
    nextSeq: (sessionId: string): number => {
      if (!counters.has(sessionId)) counters.set(sessionId, initMax(sessionId))
      const n = (counters.get(sessionId) as number) + 1
      counters.set(sessionId, n)
      return n
    },
  }
}
