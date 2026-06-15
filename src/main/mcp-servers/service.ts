// In-memory MCP config state machine over the encrypted store. CRUD setters
// validate + persist, then notify listeners (main wiring pushes the new list to
// the service process and broadcasts to renderer windows). Mirrors providers.
import {
  type McpMutationResult,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpToolOverride,
} from '@shared/types/mcp'
import { ulid } from 'ulid'

import type { Store } from './store'

export type Service = {
  list(): McpServerConfig[]
  add(input: Omit<McpServerConfig, 'id'>): Promise<McpMutationResult & { id?: string }>
  update(id: string, patch: Partial<Omit<McpServerConfig, 'id'>>): Promise<McpMutationResult>
  remove(id: string): Promise<McpMutationResult>
  setEnabled(id: string, enabled: boolean): Promise<McpMutationResult>
  setToolOverride(id: string, toolName: string, override: McpToolOverride | null): Promise<McpMutationResult>
  onChange(cb: (configs: McpServerConfig[]) => void): () => void
}

function transportValid(c: McpServerConfig): string | null {
  if (c.transport === 'stdio') return c.command?.trim() ? null : 'stdio server needs a command'
  return c.url?.trim() ? null : 'remote server needs a url'
}

export async function createService(opts: { store: Store }): Promise<Service> {
  let state = await opts.store.load()
  const listeners = new Set<(c: McpServerConfig[]) => void>()
  const emit = (): void => {
    for (const cb of listeners) cb([...state.servers])
  }

  const persist = async (servers: McpServerConfig[]): Promise<McpMutationResult> => {
    const next = { version: 1 as const, servers }
    try {
      await opts.store.save(next)
    } catch (err) {
      return { ok: false, code: 'persist_failed', message: String(err) }
    }
    state = next
    emit()
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
      const candidate: McpServerConfig = { ...input, id: ulid() }
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

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
