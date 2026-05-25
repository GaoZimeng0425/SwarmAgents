// src/main/providers/store.ts
//
// Encrypted on-disk providers store. Reads/writes a single file via Electron
// safeStorage (Keychain-backed on macOS). Saves are atomic (write tmp → rename)
// and validated against the Zod schema before encryption so we never persist
// garbage. Pure module: no logging, no globals — callers inject the filePath.
import { existsSync, promises as fs } from 'node:fs'

import { safeStorage } from 'electron'

import {
  defaultProvidersStateOnDisk,
  ProvidersStateOnDisk,
  type ProvidersStateOnDisk as ProvidersStateOnDiskT,
} from '@shared/types/provider'

export type LoadResult =
  | { ok: true; state: ProvidersStateOnDiskT }
  | { ok: false; reason: 'decrypt_failed' | 'schema_invalid' }

export type Store = {
  load(): Promise<ProvidersStateOnDiskT> // forgiving — returns defaults on missing/failure
  loadOrRecover(): Promise<LoadResult> // strict — reports failure reason
  save(state: ProvidersStateOnDiskT): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const loadOrRecover: Store['loadOrRecover'] = async () => {
    if (!existsSync(filePath)) {
      return { ok: true, state: defaultProvidersStateOnDisk() }
    }
    const buf = await fs.readFile(filePath)
    let json: string
    try {
      json = safeStorage.decryptString(buf)
    } catch {
      return { ok: false, reason: 'decrypt_failed' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, reason: 'schema_invalid' }
    }
    const checked = ProvidersStateOnDisk.safeParse(parsed)
    if (!checked.success) return { ok: false, reason: 'schema_invalid' }
    return { ok: true, state: checked.data }
  }

  const load: Store['load'] = async () => {
    const r = await loadOrRecover()
    if (r.ok) return r.state
    return defaultProvidersStateOnDisk()
  }

  const save: Store['save'] = async (state) => {
    // Validate before encrypting so we never persist garbage.
    ProvidersStateOnDisk.parse(state)
    const ciphertext = safeStorage.encryptString(JSON.stringify(state))
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, ciphertext)
    await fs.rename(tmp, filePath)
  }

  return { load, loadOrRecover, save }
}
