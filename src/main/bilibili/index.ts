// src/main/bilibili/index.ts
//
// Entry point for the Bilibili subsystem. Wires the encrypted store, auth, and IPC.
import { paths } from '../constants'
import { createAuth } from './auth'
import { wireBilibiliIpc } from './ipc'
import { createStore } from './store'

export type BilibiliHandle = { dispose(): void }

export function initBilibili(): BilibiliHandle {
  const store = createStore({ filePath: paths.bilibili() })
  const auth = createAuth({ store })
  const { dispose } = wireBilibiliIpc({ auth, store })
  return { dispose }
}
