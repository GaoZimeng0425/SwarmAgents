// src/main/providers/store.ts
//
// Encrypted on-disk providers store. Reads/writes a single file via Electron
// safeStorage (Keychain-backed on macOS). Saves are atomic (write tmp → rename)
// and validated against the Zod schema before encryption so we never persist
// garbage. Pure module: no logging, no globals — callers inject the filePath.
import { existsSync, promises as fs } from 'node:fs'
import { defaultProvidersStateOnDisk, ProvidersStateOnDisk } from '@shared/types/provider'
import { safeStorage } from 'electron'

export type LoadResult =
  | { ok: true; state: ProvidersStateOnDisk }
  | { ok: false; reason: 'decrypt_failed' | 'schema_invalid' }

export type Store = {
  load(): Promise<ProvidersStateOnDisk> // forgiving — returns defaults on missing/failure
  loadOrRecover(): Promise<LoadResult> // strict — reports failure reason
  save(state: ProvidersStateOnDisk): Promise<void>
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

  // Serialize saves so concurrent calls don't race on the shared .tmp path.
  let saveQueue: Promise<void> = Promise.resolve()

  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      // Validate before encrypting so we never persist garbage.
      ProvidersStateOnDisk.parse(state)
      const ciphertext = safeStorage.encryptString(JSON.stringify(state))
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, ciphertext)
      await fs.rename(tmp, filePath)
    })
    // Swallow rejections from the queue itself, but let the caller see their own error.
    saveQueue = next.catch(() => {})
    return next
  }

  return { load, loadOrRecover, save }
}
