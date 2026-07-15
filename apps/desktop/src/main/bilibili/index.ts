// src/main/bilibili/index.ts
//
// Entry point for the Bilibili subsystem. Wires the on-disk store, auth, and IPC.
import type { AnalyzeBilibiliRequest, AnalyzeBilibiliResult, MainMethod, ProviderInjection } from '@swarm/protocol'

import { paths } from '../constants'
import { type AnalysisStore, createAnalysisStore } from './analysis-store'
import { createArchiveStore } from './archive-store'
import { createAuth } from './auth'
import { wireBilibiliIpc } from './ipc'
import { createPinStore } from './pin-store'
import { createStore } from './store'

// Structural: only the registerRpcHandlers surface initBilibili needs.
type RpcHandlerClient = {
  registerHandler(method: MainMethod, fn: (...args: unknown[]) => Promise<unknown>): void
}

export type BilibiliHandle = {
  registerRpcHandlers(client: RpcHandlerClient): void
  dispose(): void
}

export function initBilibili(opts: {
  getInjection: () => ProviderInjection | null
  analyzeBilibili: (req: AnalyzeBilibiliRequest) => Promise<AnalyzeBilibiliResult>
}): BilibiliHandle {
  const store = createStore({ filePath: paths.bilibili() })
  const analysisStore = createAnalysisStore({ filePath: paths.bilibiliAnalysis() })
  const archiveStore = createArchiveStore({ filePath: paths.bilibiliArchive() })
  const pinStore = createPinStore({ filePath: paths.bilibiliPins() })
  const auth = createAuth({ store })
  const { dispose } = wireBilibiliIpc({
    auth,
    store,
    analysisStore,
    archiveStore,
    pinStore,
    getInjection: opts.getInjection,
    analyzeBilibili: opts.analyzeBilibili,
  })
  return {
    registerRpcHandlers(client) {
      // The service process calls this to persist an analysis result
      // (the full BiliAnalysis row: { bvid, summary, text, source, analyzedAt }).
      client.registerHandler('bilibili.save_analysis', (_bvid, analysis) =>
        Promise.resolve(analysisStore.put(analysis as Parameters<AnalysisStore['put']>[0]))
      )
    },
    dispose,
  }
}
