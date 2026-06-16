import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { McpServerConfig } from '@shared/types/mcp'

import type { ToolRunContext, ToolSpec } from './registry'

const McpAddParams = Type.Object({
  name: Type.String({
    description: 'Server name, used as the tool namespace. Letters, digits, dash, underscore only (e.g. "workpanel").',
  }),
  transport: Type.Union([Type.Literal('stdio'), Type.Literal('http'), Type.Literal('sse')], {
    description: "'stdio' for a local process, 'http' or 'sse' for a remote server.",
  }),
  command: Type.Optional(Type.String({ description: 'stdio only: the executable to run, e.g. "npx".' })),
  args: Type.Optional(Type.Array(Type.String(), { description: 'stdio only: command arguments.' })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'stdio only: environment variables.' })),
  cwd: Type.Optional(Type.String({ description: 'stdio only: working directory.' })),
  url: Type.Optional(Type.String({ description: 'remote only: server URL, e.g. "https://example.com/mcp".' })),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'remote only: request headers, e.g. { "Authorization": "Bearer ..." }.',
    })
  ),
})

type McpAddArgs = {
  name?: string
  transport?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

// Adds (and connects) an MCP server on the user's behalf. High risk: a stdio
// server runs an arbitrary local command, so the user is asked to confirm
// before this runs (permission is enforced centrally in beforeToolCall).
export function mcpAddSpec(): ToolSpec {
  return {
    group: 'mcp',
    name: 'mcp_add',
    risk: 'high',
    source: 'builtin',
    build: (ctx: ToolRunContext): AgentTool => ({
      name: 'mcp_add',
      label: 'Add an MCP server',
      description:
        "Add a Model Context Protocol server to the user's configuration and connect it, exposing its tools " +
        'to you. Use when the user asks to connect/add an MCP server and gives connection details: a command ' +
        '(transport "stdio") or a url (transport "http" / "sse"). The server is persisted and appears in ' +
        'Settings → MCP; its tools register automatically once connected.',
      parameters: McpAddParams,
      execute: async (_id: string, params: unknown) => {
        const p = (params ?? {}) as McpAddArgs
        const name = typeof p.name === 'string' ? p.name.trim() : ''
        const transport = p.transport
        if (!name || (transport !== 'stdio' && transport !== 'http' && transport !== 'sse')) {
          throw new Error('mcp_add needs a name and a transport of stdio | http | sse')
        }
        if (transport === 'stdio' && !p.command?.trim()) throw new Error('stdio server needs a command')
        if (transport !== 'stdio' && !p.url?.trim()) throw new Error('remote server needs a url')

        const config: Omit<McpServerConfig, 'id'> =
          transport === 'stdio'
            ? { name, transport, enabled: true, command: p.command?.trim(), args: p.args, env: p.env, cwd: p.cwd }
            : { name, transport, enabled: true, url: p.url?.trim(), headers: p.headers }

        const result = await ctx.addMcpServer(config)
        if (!result.ok) throw new Error(`Failed to add MCP server "${name}": ${result.message}`)

        const text =
          `Added MCP server "${name}" (${transport}). It is connecting now; its tools register ` +
          'automatically and it now appears in Settings → MCP.'
        return { content: [{ type: 'text', text }], details: { id: result.id, name } }
      },
    }),
  }
}
