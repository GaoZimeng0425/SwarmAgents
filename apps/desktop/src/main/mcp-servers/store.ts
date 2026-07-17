// Plaintext on-disk store for MCP server configs — a hand-editable
// `mcp-servers.json` keyed by server name (Claude Code's `.mcp.json` shape).
// Secrets are NOT stored here: configs use `${VAR}` references that the Service
// expands at connect time, so the file is safe to read, grep, and hand-edit.
// Atomic writes (tmp → rename); a directory watch lets external edits (by a
// human or the agent's fs tools) reload live.
import { existsSync, type FSWatcher, promises as fs, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createLogger } from '@shared/logger'
import {
  type McpServerConfig,
  McpServerConfigSchema,
  type McpServerEntry,
  type McpServersFile,
  McpServersFileSchema,
} from '@swarm/protocol'

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
function resolveTransport(entry: McpServerEntry, name: string): McpServerConfig['transport'] {
  const declared = entry.transport ?? entry.type
  // The old HTTP+SSE transport is no longer supported. Coerce a legacy `sse`
  // entry to `http` (keeps it visible/editable) instead of dropping the server.
  if (declared === 'sse') {
    log.warn({ msg: 'sse transport is no longer supported; treating as http', name })
    return 'http'
  }
  if (declared) return declared
  if (entry.command?.trim()) return 'stdio'
  return 'http'
}

function entryToConfig(name: string, entry: McpServerEntry): McpServerConfig {
  const candidate: McpServerConfig = {
    id: name, // the map key is the stable identity
    name,
    transport: resolveTransport(entry, name),
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

export function createStore(opts: { filePath: string }): Store {
  const { filePath } = opts

  const writeFile = async (file: McpServersFile): Promise<void> => {
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`)
    await fs.rename(tmp, filePath)
  }

  const load: Store['load'] = async () => {
    if (!existsSync(filePath)) return { servers: [] }
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
