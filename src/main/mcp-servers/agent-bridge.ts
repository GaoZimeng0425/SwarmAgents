// Handles the `mcp.config.add` event an in-process agent tool emits (from the
// Service) so the agent can add an MCP server. Validates + persists via the
// same config Service the settings UI uses, then returns the result + requestId
// so the caller can reply over `respondMcpAdd`.
import { createLogger } from '@shared/logger'
import { type McpAddResult, type McpServerConfig, McpServerConfigSchema } from '@shared/types/mcp'

import type { Service } from './service'

const log = createLogger({ process: 'main' }).child({ component: 'mcp-agent-bridge' })

type AddRequest = { requestId: string; config: Omit<McpServerConfig, 'id'> }

function isAddRequest(data: unknown): data is AddRequest {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as AddRequest).requestId === 'string' &&
    !!(data as AddRequest).config &&
    typeof (data as AddRequest).config === 'object'
  )
}

/** Validate + persist an agent-initiated MCP add. Returns the result paired with its requestId. */
export async function applyAgentMcpAdd(
  service: Service,
  data: unknown
): Promise<{ requestId: string; result: McpAddResult } | null> {
  if (!isAddRequest(data)) {
    log.warn({ msg: 'malformed mcp.config.add event', data })
    return null
  }
  const { requestId, config } = data
  const parsed = McpServerConfigSchema.omit({ id: true }).safeParse(config)
  if (!parsed.success) {
    log.warn({ msg: 'agent mcp add rejected: invalid config', requestId, err: parsed.error.issues[0]?.message })
    return {
      requestId,
      result: { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'invalid config' },
    }
  }
  const result = await service.add(parsed.data as Omit<McpServerConfig, 'id'>)
  log.info({ msg: 'agent mcp add', requestId, name: parsed.data.name, ok: result.ok })
  return { requestId, result }
}
