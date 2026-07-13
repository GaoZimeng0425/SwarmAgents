// src/main/bilibili/index.ts
//
// Entry point for the Bilibili subsystem. Wires the on-disk store, auth, and IPC.
import type { ProviderInjection } from '@swarm/protocol'

import { paths } from '../constants'
import { createAnalysisStore } from './analysis-store'
import { createArchiveStore } from './archive-store'
import { createAuth } from './auth'
import { wireBilibiliIpc } from './ipc'
import { createPinStore } from './pin-store'
import { createStore } from './store'

export type BilibiliHandle = { dispose(): void }

export function initBilibili(opts: { getInjection: () => ProviderInjection | null }): BilibiliHandle {
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
  })
  return { dispose }
}
