// src/main/bilibili/index.ts
//
// Entry point for the Bilibili subsystem. Wires the encrypted store, auth, and IPC.
import type { ProviderInjection } from '@shared/types/provider'

import { paths } from '../constants'
import { createAuth } from './auth'
import { wireBilibiliIpc } from './ipc'
import { createStore } from './store'

export type BilibiliHandle = { dispose(): void }

export function initBilibili(opts: { getInjection: () => ProviderInjection | null }): BilibiliHandle {
  const store = createStore({ filePath: paths.bilibili() })
  const auth = createAuth({ store })
  const { dispose } = wireBilibiliIpc({ auth, store, getInjection: opts.getInjection })
  return { dispose }
}
