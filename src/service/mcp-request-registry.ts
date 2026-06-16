import type { McpAddResult, McpServerConfig } from '@shared/types/mcp'
import { ulid } from 'ulid'

type Pending = { resolve: (r: McpAddResult) => void }

export type McpRequestRegistry = {
  /** Add an MCP server and block until Main persists it. Resolves with the mutation result. */
  add(config: Omit<McpServerConfig, 'id'>): Promise<McpAddResult>
  resolve(requestId: string, result: McpAddResult): void
}

/**
 * Lets an in-process agent tool add an MCP server even though the config store
 * lives in Main. Mirrors the ask/permission registries: `add` emits a
 * `mcp.config.add` event and blocks until Main performs the write and replies
 * via the `respondMcpAdd` RPC, which calls `resolve`.
 */
export function createMcpRequestRegistry(broadcast: (event: string, data: unknown) => void): McpRequestRegistry {
  const pending = new Map<string, Pending>()

  return {
    add(config) {
      const requestId = ulid()
      return new Promise<McpAddResult>((resolve) => {
        pending.set(requestId, { resolve })
        broadcast('mcp.config.add', { requestId, config })
      })
    },

    resolve(requestId, result) {
      const p = pending.get(requestId)
      if (!p) return
      pending.delete(requestId)
      p.resolve(result)
    },
  }
}
