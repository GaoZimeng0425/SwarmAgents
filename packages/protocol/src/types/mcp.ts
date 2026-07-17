// MCP (Model Context Protocol) server configuration + live status.
//
// Config lives in Main (encrypted at rest, edited via the settings UI) and is
// pushed to the Service over RPC. The Service runs the MCP clients, discovers
// each server's tools, registers them into the ToolRegistry, and pushes live
// connection status back to the renderer over the event pipe.
import { z } from 'zod'

export const McpTransport = z.enum(['stdio', 'http'])
export type McpTransport = z.infer<typeof McpTransport>

// Transports accepted when READING a hand-written/legacy config. The old
// HTTP+SSE transport is deprecated and no longer connected — but a stored
// `"sse"` entry must still parse (it is coerced to `http` on read) so one
// legacy entry can't fail-parse the whole file. Never used for new configs.
export const McpTransportRead = z.enum(['stdio', 'http', 'sse'])

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
  // remote (http) transport. Not `.url()`: may hold a `${VAR}` reference
  // that only becomes a valid URL after env expansion at connect time.
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // per-tool overrides keyed by the server's own tool name
  toolOverrides: z.record(z.string(), McpToolOverrideSchema).optional(),
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

// --- on-disk format: a plaintext, hand-editable `mcp-servers.json` keyed by
// server name (Claude Code's `.mcp.json` shape). Secrets are NOT stored here;
// use `${VAR}` / `${VAR:-default}` references, expanded at connect time. The
// server name is the map key, so it doubles as the stable id internally.
export const McpServerEntrySchema = z.object({
  // `type` is the Claude Code key; `transport` is accepted as an alias on read.
  // Uses the lenient read enum so a legacy `"sse"` entry still parses.
  type: McpTransportRead.optional(),
  transport: McpTransportRead.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // app extensions beyond Claude Code's format; both optional (default enabled).
  enabled: z.boolean().optional(),
  toolOverrides: z.record(z.string(), McpToolOverrideSchema).optional(),
})
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>

export const McpServersFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerEntrySchema).default({}),
})
export type McpServersFile = z.infer<typeof McpServersFileSchema>

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
