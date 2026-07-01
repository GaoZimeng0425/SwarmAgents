// Plaintext on-disk store for MCP server configs — a hand-editable
// `mcp-servers.json` keyed by server name (Claude Code's `.mcp.json` shape).
// Secrets are NOT stored here: configs use `${VAR}` references that the Service
// expands at connect time, so the file is safe to read, grep, and hand-edit.
// Atomic writes (tmp → rename); a directory watch lets external edits (by a
// human or the agent's fs tools) reload live. One-time migration decrypts a
// legacy `mcp-servers.enc` if present.
import { existsSync, type FSWatcher, promises as fs, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createLogger } from '@shared/logger'
import {
  type McpServerConfig,
  McpServerConfigSchema,
  type McpServerEntry,
  type McpServersFile,
  McpServersFileSchema,
} from '@shared/types/mcp'
import { safeStorage } from 'electron'

const log = createLogger({ process: 'main' }).child({ component: 'mcp-servers-store' })

export type McpServersState = { servers: McpServerConfig[] }

export type Store = {
  /** Read + recover (migrating a legacy .enc on first run). Never throws. */
  load(): Promise<McpServersState>
  save(state: McpServersState): Promise<void>
  /** Fire `onChange` (debounced) when the file is edited outside this process. */
  watch(onChange: () => void): () => void
  readonly path: string
}

/** Resolve a hand-written entry's transport: explicit, else inferred from fields. */
function resolveTransport(entry: McpServerEntry): McpServerConfig['transport'] {
  const declared = entry.transport ?? entry.type
  if (declared) return declared
  if (entry.command?.trim()) return 'stdio'
  return 'http'
}

function entryToConfig(name: string, entry: McpServerEntry): McpServerConfig {
  const candidate: McpServerConfig = {
    id: name, // the map key is the stable identity
    name,
    transport: resolveTransport(entry),
    enabled: entry.enabled ?? true,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    url: entry.url,
    headers: entry.headers,
    toolOverrides: entry.toolOverrides,
  }
  return McpServerConfigSchema.parse(candidate)
}

/** Drop undefined/empty fields so the written file stays clean for hand-editing. */
function configToEntry(c: McpServerConfig): McpServerEntry {
  const entry: McpServerEntry = { type: c.transport }
  if (c.transport === 'stdio') {
    if (c.command) entry.command = c.command
    if (c.args?.length) entry.args = c.args
    if (c.env && Object.keys(c.env).length) entry.env = c.env
    if (c.cwd) entry.cwd = c.cwd
  } else {
    if (c.url) entry.url = c.url
    if (c.headers && Object.keys(c.headers).length) entry.headers = c.headers
  }
  if (c.enabled === false) entry.enabled = false // omit when true (the default)
  if (c.toolOverrides && Object.keys(c.toolOverrides).length) entry.toolOverrides = c.toolOverrides
  return entry
}

function fileToConfigs(file: McpServersFile): McpServerConfig[] {
  const out: McpServerConfig[] = []
  for (const [name, entry] of Object.entries(file.mcpServers)) {
    try {
      out.push(entryToConfig(name, entry))
    } catch (err) {
      log.warn({
        msg: 'skipping invalid mcp server entry',
        name,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

function configsToFile(servers: McpServerConfig[]): McpServersFile {
  const mcpServers: Record<string, McpServerEntry> = {}
  for (const c of servers) mcpServers[c.name] = configToEntry(c)
  return { mcpServers }
}

/** Best-effort one-time migration from the legacy encrypted store. */
async function migrateFromEnc(encPath: string): Promise<McpServerConfig[] | null> {
  if (!existsSync(encPath)) return null
  try {
    const buf = await fs.readFile(encPath)
    const json = safeStorage.decryptString(buf)
    const parsed = JSON.parse(json) as { servers?: unknown[] }
    const servers = Array.isArray(parsed.servers) ? parsed.servers : []
    const configs: McpServerConfig[] = []
    for (const s of servers) {
      const withId = { ...(s as McpServerConfig), id: (s as McpServerConfig).name }
      const checked = McpServerConfigSchema.safeParse(withId)
      if (checked.success) configs.push(checked.data)
    }
    log.info({ msg: 'migrated legacy encrypted mcp config', count: configs.length })
    return configs
  } catch (err) {
    log.warn({ msg: 'legacy mcp config migration failed; starting empty', err: String(err) })
    return null
  }
}

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts
  const encPath = filePath.replace(/\.json$/, '.enc')

  const writeFile = async (file: McpServersFile): Promise<void> => {
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`)
    await fs.rename(tmp, filePath)
  }

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) {
      const migrated = await migrateFromEnc(encPath)
      if (migrated) {
        await writeFile(configsToFile(migrated)).catch((err) =>
          log.warn({ msg: 'failed to persist migrated config', err: String(err) })
        )
        return { servers: migrated }
      }
      return { servers: [] }
    }
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const checked = McpServersFileSchema.safeParse(JSON.parse(raw))
      if (!checked.success) {
        log.warn({ msg: 'mcp-servers.json failed schema; keeping it but loading empty', err: checked.error.message })
        return { servers: [] }
      }
      return { servers: fileToConfigs(checked.data) }
    } catch (err) {
      log.warn({ msg: 'mcp-servers.json unreadable/invalid JSON; loading empty', err: String(err) })
      return { servers: [] }
    }
  }

  let saveQueue: Promise<void> = Promise.resolve()
  const save: Store['save'] = (state) => {
    const next = saveQueue.then(() => writeFile(configsToFile(state.servers)))
    saveQueue = next.catch(() => {})
    return next
  }

  const watchFile: Store['watch'] = (onChange) => {
    const dir = dirname(filePath)
    const base = basename(filePath)
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null
    try {
      // Watch the directory, not the file: atomic rename swaps the inode, which
      // would silently kill a file-level watcher.
      watcher = watch(dir, (_event, changed) => {
        if (changed && changed !== base) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(onChange, 250)
      })
    } catch (err) {
      log.warn({ msg: 'failed to watch mcp config dir; live reload disabled', err: String(err) })
    }
    return () => {
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  }

  return { load, save, watch: watchFile, path: filePath }
}
