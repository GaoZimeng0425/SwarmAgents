// Global store for streaming-analysis state, keyed by analysis id. Survives panel
// unmount/remount so the user doesn't lose the in-flight streaming progress when
// they switch away and back. Previously this lived in useAnalysisStream's useState,
// which was lost on every unmount (the "切走丢失" bug).
//
// The store is a flat Map keyed by `${namespace}:${id}` where namespace is the
// flow's complete-event kind (e.g. 'article.analysisComplete') — unique per flow,
// so article-id '1' and bilibili-bvid '1' don't collide.
import { create } from 'zustand'

export type AnalysisStreamState =
  | { phase: 'idle' }
  | { phase: 'streaming'; streamText: string }
  | { phase: 'done'; result: unknown; streamText: string }
  | { phase: 'error'; error: string }

type State = {
  entries: Map<string, AnalysisStreamState>
  /** Read the state for a key, defaulting to idle. */
  get: (key: string) => AnalysisStreamState
  /** Replace the state for a key. */
  set: (key: string, state: AnalysisStreamState) => void
  /** Functional update (like setState). */
  update: (key: string, fn: (prev: AnalysisStreamState) => AnalysisStreamState) => void
  /** Clear a key (e.g. when the user explicitly re-runs from scratch). */
  clear: (key: string) => void
}

export const useAnalysisStreamStore = create<State>((set, get) => ({
  entries: new Map(),
  get: (key) => get().entries.get(key) ?? { phase: 'idle' },
  set: (key, state) =>
    set((s) => {
      const next = new Map(s.entries)
      next.set(key, state)
      return { entries: next }
    }),
  update: (key, fn) =>
    set((s) => {
      const prev = s.entries.get(key) ?? { phase: 'idle' as const }
      const next = new Map(s.entries)
      next.set(key, fn(prev))
      return { entries: next }
    }),
  clear: (key) =>
    set((s) => {
      const next = new Map(s.entries)
      next.delete(key)
      return { entries: next }
    }),
}))

/** Build the store key from the flow's complete-event kind + the analysis id. */
export function streamKey(namespace: string, id: string): string {
  return `${namespace}:${id}`
}
