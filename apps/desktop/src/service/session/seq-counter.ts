// Per-session monotonic seq counter. Lazily initializes from the max persisted
// run_event seq so a resumed session continues past its history (no collision
// across service restarts). Centralized so makeRunEmit shares one
// seq-assignment point.
export type SeqCounter = {
  nextSeq: (sessionId: string) => number
}

/** Minimal shape createSeqCounter reads from a session's run event rows. */
export type RunEventRow = { seq: number }

export function createSeqCounter(getRunEvents: (sessionId: string) => RunEventRow[] = () => []): SeqCounter {
  const counters = new Map<string, number>()

  const initMax = (sessionId: string): number => {
    let max = 0
    for (const r of getRunEvents(sessionId)) {
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
