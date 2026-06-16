// MCP (Model Context Protocol) server configuration + live status.
//
// Config lives in Main (encrypted at rest, edited via the settings UI) and is
// pushed to the Service over RPC. The Service runs the MCP clients, discovers
// each server's tools, registers them into the ToolRegistry, and pushes live
// connection status back to the renderer over the event pipe.
import { z } from 'zod'

export const McpTransport = z.enum(['stdio', 'http', 'sse'])
export type McpTransport = z.infer<typeof McpTransport>

// Default risk for tools discovered from an MCP server. External tools are
// untrusted, so they require confirmation unless the user lowers the risk.
export const McpToolRisk = z.enum(['low', 'medium', 'high'])
export type McpToolRisk = z.infer<typeof McpToolRisk>

/** Per-tool overrides, keyed by tool name within a server. */
export const McpToolOverrideSchema = z.object({
  enabled: z.boolean().default(true),
  risk: McpToolRisk.optional(),
})
export type McpToolOverride = z.infer<typeof McpToolOverrideSchema>

export const McpServerConfigSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Letters, digits, dash and underscore only — used as the tool namespace.'),
  transport: McpTransport,
  enabled: z.boolean().default(true),
  // stdio transport
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  // remote (http / sse) transport
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // per-tool overrides keyed by the server's own tool name
  toolOverrides: z.record(z.string(), McpToolOverrideSchema).optional(),
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

export const McpServersOnDiskSchema = z.object({
  version: z.literal(1),
  servers: z.array(McpServerConfigSchema).default([]),
})
export type McpServersOnDisk = z.infer<typeof McpServersOnDiskSchema>

export const emptyMcpServers = (): McpServersOnDisk => ({ version: 1, servers: [] })

// --- live status (Service → Main → renderer) ---

export const McpConnectionState = z.enum(['idle', 'connecting', 'connected', 'error'])
export type McpConnectionState = z.infer<typeof McpConnectionState>

export type McpToolInfo = {
  name: string
  description?: string
  /** effective risk after applying overrides */
  risk: McpToolRisk
  enabled: boolean
}

export type McpServerStatus = {
  id: string
  state: McpConnectionState
  error?: string
  tools: McpToolInfo[]
}

/** Result of an add/update/remove/toggle config mutation (mirrors providers). */
export type McpMutationResult = { ok: true } | { ok: false; code: string; message: string }

/** Result of an `add`, carrying the assigned id on success. */
export type McpAddResult = McpMutationResult & { id?: string }
