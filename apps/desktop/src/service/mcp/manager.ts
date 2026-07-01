import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createLogger } from '@shared/logger'
import type { McpServerConfig, McpServerStatus, McpToolInfo, McpToolRisk } from '@swarm/protocol'

import type { ToolRegistry, ToolSpec } from '../tools/registry'

const log = createLogger({ process: 'service' }).child({ component: 'mcp-manager' })

// The slice of the MCP SDK Client we use. Narrowed to an interface so tests can
// inject a fake without spawning processes or opening sockets.
export type McpClientLike = {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>
  callTool(params: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<{ content?: Array<Record<string, unknown>>; isError?: boolean }>
  close(): Promise<void>
}

export type McpConnector = (config: McpServerConfig) => Promise<McpClientLike>

type TextOrImage = TextContent | ImageContent

const DEFAULT_RISK: McpToolRisk = 'medium'

/** Connection-relevant fingerprint — a change means we must reconnect. */
function fingerprint(c: McpServerConfig): string {
  return JSON.stringify({
    transport: c.transport,
    command: c.command,
    args: c.args,
    env: c.env,
    cwd: c.cwd,
    url: c.url,
    headers: c.headers,
    enabled: c.enabled,
    toolOverrides: c.toolOverrides,
  })
}

function mapContent(content: Array<Record<string, unknown>> | undefined): TextOrImage[] {
  if (!content || content.length === 0) return [{ type: 'text', text: '' }]
  return content.map((item) => {
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text }
    if (item.type === 'image') return item as unknown as ImageContent
    return { type: 'text', text: JSON.stringify(item) }
  })
}

function textOf(content: TextOrImage[]): string {
  return content
    .map((c) => (c.type === 'text' ? (c as { text: string }).text : ''))
    .join('')
    .trim()
}

/**
 * Expand `${VAR}` and `${VAR:-default}` references against the process env, so
 * secrets (tokens, keys) stay out of the on-disk config and live in the
 * environment instead. An unset variable with no default expands to ''.
 */
export function expandVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name]
    return v !== undefined && v !== '' ? v : (def ?? '')
  })
}

const expandRecord = (rec: Record<string, string> | undefined): Record<string, string> | undefined =>
  rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expandVars(v)])) : undefined

/** Default connector — builds a real MCP SDK client + transport for a config. */
export const defaultConnect: McpConnector = async (config) => {
  const client = new Client({ name: 'swarm-agents', version: '1.0.0' }, { capabilities: {} })
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('stdio server requires a command')
    const transport = new StdioClientTransport({
      command: expandVars(config.command),
      args: config.args?.map((a) => expandVars(a)),
      env: { ...getDefaultEnvironment(), ...(expandRecord(config.env) ?? {}) },
      cwd: config.cwd,
    })
    await client.connect(transport)
  } else {
    if (!config.url) throw new Error('remote server requires a url')
    const url = new URL(expandVars(config.url))
    const headers = expandRecord(config.headers)
    const opts = headers ? { requestInit: { headers } } : undefined
    const transport =
      config.transport === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts)
    await client.connect(transport)
  }
  return client as unknown as McpClientLike
}

export type McpManager = {
  /** Reconcile live connections to match the given configs. */
  setServers(configs: McpServerConfig[]): Promise<void>
  getStatus(): McpServerStatus[]
  dispose(): Promise<void>
}

type Connection = { client: McpClientLike; name: string; fingerprint: string }

export function createMcpManager(deps: {
  toolRegistry: ToolRegistry
  emitStatus: (statuses: McpServerStatus[]) => void
  connect?: McpConnector
}): McpManager {
  const connect = deps.connect ?? defaultConnect
  const connections = new Map<string, Connection>()
  const statuses = new Map<string, McpServerStatus>()

  const emit = (): void => deps.emitStatus(Array.from(statuses.values()))

  const teardown = async (id: string): Promise<void> => {
    const conn = connections.get(id)
    if (!conn) return
    connections.delete(id)
    deps.toolRegistry.unregister(conn.name)
    try {
      await conn.client.close()
    } catch (err) {
      log.warn({ msg: 'mcp client close failed', id, err: String(err) })
    }
  }

  const buildSpec = (
    serverName: string,
    tool: { name: string; description?: string; inputSchema?: unknown },
    client: McpClientLike,
    risk: McpToolRisk
  ): ToolSpec => {
    const modelName = `${serverName}__${tool.name}`
    return {
      group: serverName,
      name: modelName,
      risk,
      source: 'mcp',
      build: (): AgentTool => ({
        name: modelName,
        label: `${serverName}: ${tool.name}`,
        description: tool.description ?? `MCP tool "${tool.name}" from server "${serverName}".`,
        parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as AgentTool['parameters'],
        execute: async (_id: string, params: unknown) => {
          const res = await client.callTool({ name: tool.name, arguments: (params as Record<string, unknown>) ?? {} })
          const content = mapContent(res.content)
          // pi convention: throw on failure rather than encoding errors in content.
          if (res.isError) throw new Error(textOf(content) || `MCP tool "${tool.name}" failed`)
          return { content, details: {} }
        },
      }),
    }
  }

  const connectServer = async (config: McpServerConfig): Promise<void> => {
    statuses.set(config.id, { id: config.id, state: 'connecting', tools: [] })
    emit()
    try {
      const client = await connect(config)
      const { tools } = await client.listTools()
      deps.toolRegistry.unregister(config.name)
      // Report every discovered tool (so the UI can re-enable disabled ones),
      // but only register enabled tools with the agent.
      const toolInfos: McpToolInfo[] = []
      for (const t of tools) {
        const override = config.toolOverrides?.[t.name]
        const enabled = override?.enabled !== false
        const risk = override?.risk ?? DEFAULT_RISK
        if (enabled) deps.toolRegistry.register(buildSpec(config.name, t, client, risk))
        toolInfos.push({ name: t.name, description: t.description, risk, enabled })
      }
      connections.set(config.id, { client, name: config.name, fingerprint: fingerprint(config) })
      statuses.set(config.id, { id: config.id, state: 'connected', tools: toolInfos })
      log.info({ msg: 'mcp server connected', id: config.id, name: config.name, toolCount: toolInfos.length })
    } catch (err) {
      statuses.set(config.id, { id: config.id, state: 'error', error: String(err), tools: [] })
      log.warn({ msg: 'mcp server connect failed', id: config.id, name: config.name, err: String(err) })
    }
    emit()
  }

  return {
    async setServers(configs) {
      const desired = new Map(configs.map((c) => [c.id, c]))

      // Tear down anything removed, disabled, or whose connection config changed.
      for (const [id, conn] of [...connections]) {
        const cfg = desired.get(id)
        const unchanged = cfg?.enabled && fingerprint(cfg) === conn.fingerprint
        if (!unchanged) await teardown(id)
      }

      // Drop stale statuses for servers no longer configured.
      for (const id of [...statuses.keys()]) {
        if (!desired.has(id)) statuses.delete(id)
      }

      // Disabled servers show as idle (no tools).
      for (const c of configs) {
        if (!c.enabled) statuses.set(c.id, { id: c.id, state: 'idle', tools: [] })
      }

      // Connect enabled servers that aren't already live.
      const toConnect = configs.filter((c) => c.enabled && !connections.has(c.id))
      await Promise.allSettled(toConnect.map((c) => connectServer(c)))
      emit()
    },
    getStatus() {
      return Array.from(statuses.values())
    },
    async dispose() {
      await Promise.allSettled([...connections.keys()].map((id) => teardown(id)))
      statuses.clear()
    },
  }
}
