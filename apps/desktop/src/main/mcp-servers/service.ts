// In-memory MCP config state machine over the plaintext store. CRUD setters
// validate + persist, then notify listeners (main wiring pushes the new list to
// the service process and broadcasts to renderer windows). `reload` re-reads the
// file after an external edit. Mirrors providers.
import { createLogger } from '@shared/logger'
import {
  type McpMutationResult,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpToolOverride,
} from '@shared/types/mcp'

import type { McpServersState, Store } from './store'

const log = createLogger({ process: 'main' }).child({ component: 'mcp-servers-service' })

export type Service = {
  list(): McpServerConfig[]
  add(input: Omit<McpServerConfig, 'id'>): Promise<McpMutationResult & { id?: string }>
  update(id: string, patch: Partial<Omit<McpServerConfig, 'id'>>): Promise<McpMutationResult>
  remove(id: string): Promise<McpMutationResult>
  setEnabled(id: string, enabled: boolean): Promise<McpMutationResult>
  setToolOverride(id: string, toolName: string, override: McpToolOverride | null): Promise<McpMutationResult>
  /** Re-read the file after an external edit; emits only if the content changed. */
  reload(): Promise<void>
  onChange(cb: (configs: McpServerConfig[]) => void): () => void
}

function transportValid(c: McpServerConfig): string | null {
  if (c.transport === 'stdio') return c.command?.trim() ? null : 'stdio server needs a command'
  return c.url?.trim() ? null : 'remote server needs a url'
}

export async function createService(opts: { store: Store }): Promise<Service> {
  let state: McpServersState = await opts.store.load()
  const listeners = new Set<(c: McpServerConfig[]) => void>()
  const emit = (): void => {
    for (const cb of listeners) cb([...state.servers])
  }

  const persist = async (servers: McpServerConfig[]): Promise<McpMutationResult> => {
    const prev = state
    // Optimistic: update + notify first so the UI is snappy and a subsequent
    // self-triggered file-watch reload sees matching content and no-ops.
    state = { servers }
    emit()
    try {
      await opts.store.save(state)
    } catch (err) {
      log.error({ msg: 'failed to persist mcp servers', err: err instanceof Error ? err.message : String(err) })
      state = prev
      emit()
      return { ok: false, code: 'persist_failed', message: String(err) }
    }
    return { ok: true }
  }

  const validate = (candidate: McpServerConfig, ignoreId?: string): McpMutationResult | null => {
    const parsed = McpServerConfigSchema.safeParse(candidate)
    if (!parsed.success)
      return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid config' }
    const transportErr = transportValid(parsed.data)
    if (transportErr) return { ok: false, code: 'invalid', message: transportErr }
    const nameTaken = state.servers.some(
      (s) => s.id !== ignoreId && s.name.toLowerCase() === candidate.name.toLowerCase()
    )
    if (nameTaken)
      return { ok: false, code: 'duplicate_name', message: `A server named "${candidate.name}" already exists.` }
    return null
  }

  return {
    list: () => [...state.servers],

    async add(input) {
      // The server name is the on-disk map key, so it doubles as the id.
      const candidate: McpServerConfig = { ...input, id: input.name }
      const err = validate(candidate)
      if (err) return err
      const result = await persist([...state.servers, candidate])
      return result.ok ? { ok: true, id: candidate.id } : result
    },

    async update(id, patch) {
      const existing = state.servers.find((s) => s.id === id)
      if (!existing) return { ok: false, code: 'not_found', message: `server ${id} not found` }
      const candidate: McpServerConfig = { ...existing, ...patch, id }
      const err = validate(candidate, id)
      if (err) return err
      return persist(state.servers.map((s) => (s.id === id ? candidate : s)))
    },

    async remove(id) {
      if (!state.servers.some((s) => s.id === id))
        return { ok: false, code: 'not_found', message: `server ${id} not found` }
      return persist(state.servers.filter((s) => s.id !== id))
    },

    async setEnabled(id, enabled) {
      const existing = state.servers.find((s) => s.id === id)
      if (!existing) return { ok: false, code: 'not_found', message: `server ${id} not found` }
      return persist(state.servers.map((s) => (s.id === id ? { ...s, enabled } : s)))
    },

    async setToolOverride(id, toolName, override) {
      const existing = state.servers.find((s) => s.id === id)
      if (!existing) return { ok: false, code: 'not_found', message: `server ${id} not found` }
      const overrides = { ...(existing.toolOverrides ?? {}) }
      if (override === null) delete overrides[toolName]
      else overrides[toolName] = override
      return persist(state.servers.map((s) => (s.id === id ? { ...s, toolOverrides: overrides } : s)))
    },

    async reload() {
      const next = await opts.store.load()
      // Skip our own writes / no-op edits so the watcher can't cause a feedback loop.
      if (JSON.stringify(next.servers) === JSON.stringify(state.servers)) return
      state = next
      emit()
      log.info({ msg: 'mcp config reloaded from disk', count: next.servers.length })
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
