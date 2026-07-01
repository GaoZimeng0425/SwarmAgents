// src/main/trending/index.ts
//
// Entry point for the trending subsystem. No persistent store — just wires IPC.
import { wireTrendingIpc } from './ipc'

export type TrendingHandle = {
  dispose(): void
}

export function initTrending(): TrendingHandle {
  const { dispose } = wireTrendingIpc()
  return { dispose }
}
