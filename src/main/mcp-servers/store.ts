// Encrypted on-disk store for MCP server configs. Mirrors the providers store:
// single file via Electron safeStorage (Keychain on macOS), atomic writes
// (tmp → rename), Zod-validated before encryption. Server env/headers can hold
// tokens, so the file is encrypted at rest. Pure module — callers inject the path.
import { existsSync, promises as fs } from 'node:fs'
import { emptyMcpServers, type McpServersOnDisk, McpServersOnDiskSchema } from '@shared/types/mcp'
import { safeStorage } from 'electron'

export type LoadResult =
  | { ok: true; state: McpServersOnDisk }
  | { ok: false; reason: 'decrypt_failed' | 'schema_invalid' }

export type Store = {
  load(): Promise<McpServersOnDisk>
  loadOrRecover(): Promise<LoadResult>
  save(state: McpServersOnDisk): Promise<void>
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const loadOrRecover: Store['loadOrRecover'] = async () => {
    if (!existsSync(filePath)) return { ok: true, state: emptyMcpServers() }
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
    const checked = McpServersOnDiskSchema.safeParse(parsed)
    if (!checked.success) return { ok: false, reason: 'schema_invalid' }
    return { ok: true, state: checked.data }
  }

  const load: Store['load'] = async () => {
    const r = await loadOrRecover()
    return r.ok ? r.state : emptyMcpServers()
  }

  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (state) => {
    const next = saveQueue.then(async () => {
      McpServersOnDiskSchema.parse(state)
      const ciphertext = safeStorage.encryptString(JSON.stringify(state))
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, ciphertext)
      await fs.rename(tmp, filePath)
    })
    saveQueue = next.catch(() => {})
    return next
  }

  return { load, loadOrRecover, save }
}
