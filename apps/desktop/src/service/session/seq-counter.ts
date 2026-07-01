import type { Task } from '@shared/types/task'

// Per-session monotonic seq counter. Lazily initializes from the max persisted
// seq so a resumed session continues past its history (no collision across
// service restarts). Centralized so makeEmit is the single seq-assignment point.
export type SeqCounter = {
  nextSeq: (sessionId: string) => number
}

export function createSeqCounter(getSessionTasks: (sessionId: string) => Task[]): SeqCounter {
  const counters = new Map<string, number>()

  const initMax = (sessionId: string): number => {
    let max = 0
    for (const t of getSessionTasks(sessionId)) {
      for (const ev of t.history) {
        if (typeof ev.seq === 'number' && ev.seq > max) max = ev.seq
      }
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
