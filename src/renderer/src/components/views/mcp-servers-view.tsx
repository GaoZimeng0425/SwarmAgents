import { useState } from 'react'
import type { McpConnectionState, McpServerConfig, McpToolRisk, McpTransport } from '@shared/types/mcp'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useMcpServers } from '@/hooks/use-mcp-servers'
import { SettingsHeader } from './settings-primitives'

const RISKS: McpToolRisk[] = ['low', 'medium', 'high']

const STATE_BADGE: Record<McpConnectionState, { label: string; className: string }> = {
  idle: { label: 'Disabled', className: 'bg-muted text-muted-foreground' },
  connecting: { label: 'Connecting', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  connected: { label: 'Connected', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  error: { label: 'Error', className: 'bg-destructive/15 text-destructive' },
}

type AddInput = Omit<McpServerConfig, 'id'>

// Quote-aware: keeps `"a b"`, `'a b'`, and `--flag=value with no space` intact
// where the naive whitespace split would shred a path or quoted argument.
const parseArgs = (s: string): string[] =>
  Array.from(s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (m) => m[1] ?? m[2] ?? m[3] ?? '')

const parseKeyVals = (s: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return out
}

const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string')

/** Turn one server's JSON config (claude_desktop_config.json shape) into our AddInput. */
function coerceServer(name: string, raw: Record<string, unknown>): AddInput {
  const declared = (raw.transport ?? raw.type) as string | undefined
  const hasCommand = typeof raw.command === 'string' && raw.command.trim().length > 0
  const hasUrl = typeof raw.url === 'string' && raw.url.trim().length > 0

  let transport: McpTransport
  if (declared === 'stdio' || declared === 'http' || declared === 'sse') transport = declared
  else if (hasCommand) transport = 'stdio'
  else if (hasUrl) transport = 'http'
  else throw new Error(`"${name}" needs a command (stdio) or a url (remote)`)

  const base = { name, transport, enabled: true } as const
  if (transport === 'stdio') {
    if (!hasCommand) throw new Error(`"${name}" is stdio but has no command`)
    return {
      ...base,
      command: (raw.command as string).trim(),
      args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
      env: isStringRecord(raw.env) ? raw.env : undefined,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    }
  }
  if (!hasUrl) throw new Error(`"${name}" is remote but has no url`)
  return { ...base, url: (raw.url as string).trim(), headers: isStringRecord(raw.headers) ? raw.headers : undefined }
}

/**
 * Parse pasted MCP JSON into one or more servers. Accepts the three shapes that
 * appear in the wild: the `{ "mcpServers": {...} }` wrapper, a bare
 * name→config map, and a single server object (named via the Name field).
 */
function parseMcpJson(text: string, fallbackName: string): AddInput[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (!data || typeof data !== 'object') throw new Error('Expected a JSON object')
  const obj = data as Record<string, unknown>

  const map = (obj.mcpServers ?? obj.servers) as Record<string, unknown> | undefined
  if (map && typeof map === 'object') {
    const entries = Object.entries(map)
    if (entries.length === 0) throw new Error('No servers found under "mcpServers"')
    return entries.map(([n, cfg]) => coerceServer(n, cfg as Record<string, unknown>))
  }

  // A single server object — distinguished by its config keys, named via the form.
  if ('command' in obj || 'url' in obj || 'type' in obj || 'transport' in obj) {
    if (!fallbackName.trim()) throw new Error('Enter a Name above for this server')
    return [coerceServer(fallbackName.trim(), obj)]
  }

  // Otherwise treat it as a bare name→config map (every value is an object).
  const entries = Object.entries(obj)
  if (entries.length > 0 && entries.every(([, v]) => !!v && typeof v === 'object')) {
    return entries.map(([n, cfg]) => coerceServer(n, cfg as Record<string, unknown>))
  }
  throw new Error("Unrecognized shape — paste a server's JSON config")
}

async function report(p: Promise<{ ok: boolean; message?: string }>, okMsg?: string): Promise<void> {
  const r = await p
  if (!r.ok) toast.error(r.message ?? 'Operation failed')
  else if (okMsg) toast.success(okMsg)
}

const JSON_PLACEHOLDER = `Paste a server's JSON, e.g.

{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}`

/** Add server(s), reporting per-server failures and a single success toast. */
async function addAll(inputs: AddInput[]): Promise<number> {
  let added = 0
  for (const input of inputs) {
    const r = await window.swarm.mcp.add(input)
    if (r.ok) added++
    else toast.error(`${input.name}: ${r.message}`)
  }
  if (added > 0) toast.success(added === 1 ? `Added "${inputs[0]?.name}"` : `Added ${added} servers`)
  return added
}

function PasteJsonForm(): React.JSX.Element {
  const [name, setName] = useState('')
  const [json, setJson] = useState('')

  const submit = async (): Promise<void> => {
    let inputs: AddInput[]
    try {
      inputs = parseMcpJson(json, name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid config')
      return
    }
    const added = await addAll(inputs)
    if (added > 0) {
      setJson('')
      setName('')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        onChange={(e) => setName(e.target.value)}
        placeholder="Name — only needed if the JSON is a single unnamed server"
        value={name}
      />
      <Textarea
        className="min-h-40 font-mono text-xs"
        onChange={(e) => setJson(e.target.value)}
        placeholder={JSON_PLACEHOLDER}
        value={json}
      />
      <div className="flex justify-end">
        <Button className="gap-1.5" disabled={!json.trim()} onClick={() => void submit()}>
          <Plus className="size-4" />
          Import
        </Button>
      </div>
    </div>
  )
}

function ManualForm(): React.JSX.Element {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    const base = { name: name.trim(), transport, enabled: true }
    const input: AddInput =
      transport === 'stdio'
        ? { ...base, command: command.trim(), args: parseArgs(args), env: parseKeyVals(envText) }
        : { ...base, url: url.trim(), headers: parseKeyVals(headersText) }
    const added = await addAll([input])
    if (added > 0) {
      setName('')
      setCommand('')
      setArgs('')
      setUrl('')
      setEnvText('')
      setHeadersText('')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          className="flex-1"
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (used as the tool namespace, e.g. github)"
          value={name}
        />
        <NativeSelect onChange={(e) => setTransport(e.target.value as McpTransport)} value={transport}>
          <NativeSelectOption value="stdio">stdio (local)</NativeSelectOption>
          <NativeSelectOption value="http">http (remote)</NativeSelectOption>
          <NativeSelectOption value="sse">sse (remote)</NativeSelectOption>
        </NativeSelect>
      </div>
      {transport === 'stdio' ? (
        <>
          <Input onChange={(e) => setCommand(e.target.value)} placeholder="Command, e.g. npx" value={command} />
          <Input
            onChange={(e) => setArgs(e.target.value)}
            placeholder="Args, e.g. -y @modelcontextprotocol/server-filesystem /path"
            value={args}
          />
          <Textarea
            className="min-h-16 font-mono text-xs"
            onChange={(e) => setEnvText(e.target.value)}
            placeholder="Env (one KEY=value per line, optional)"
            value={envText}
          />
        </>
      ) : (
        <>
          <Input
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Server URL, e.g. https://example.com/mcp"
            value={url}
          />
          <Textarea
            className="min-h-16 font-mono text-xs"
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder="Headers (one Key=value per line, optional)"
            value={headersText}
          />
        </>
      )}
      <div className="flex justify-end">
        <Button className="gap-1.5" onClick={() => void submit()}>
          <Plus className="size-4" />
          Add server
        </Button>
      </div>
    </div>
  )
}

function AddServerForm(): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-card p-4">
      <Tabs defaultValue="json">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-medium text-sm">Add a server</h3>
          <TabsList>
            <TabsTrigger value="json">Paste JSON</TabsTrigger>
            <TabsTrigger value="manual">Form</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="json">
          <PasteJsonForm />
        </TabsContent>
        <TabsContent value="manual">
          <ManualForm />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ServerCard({ server }: { server: McpServerConfig }): React.JSX.Element {
  const { statusById } = useMcpServers()
  const status = statusById.get(server.id)
  const state: McpConnectionState = status?.state ?? (server.enabled ? 'connecting' : 'idle')
  const badge = STATE_BADGE[state]

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{server.name}</span>
            <Badge className={badge.className} variant="secondary">
              {state === 'connecting' && <Loader2 className="mr-1 size-3 animate-spin" />}
              {badge.label}
            </Badge>
            <span className="text-muted-foreground text-xs">{server.transport}</span>
          </div>
          <p className="truncate text-muted-foreground text-xs">
            {server.transport === 'stdio'
              ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim()
              : server.url}
          </p>
        </div>
        <Switch
          checked={server.enabled}
          onCheckedChange={(v) => void report(window.swarm.mcp.setEnabled(server.id, v))}
        />
        <Button
          aria-label="Remove server"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => void report(window.swarm.mcp.remove(server.id))}
          size="icon"
          variant="ghost"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {state === 'error' && status?.error && (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-destructive text-xs">{status.error}</p>
      )}

      {status && status.tools.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 border-t pt-3">
          <span className="text-muted-foreground text-xs">Tools ({status.tools.length})</span>
          {status.tools.map((t) => (
            <div className="flex items-center gap-2 text-sm" key={t.name}>
              <Switch
                checked={t.enabled}
                onCheckedChange={(v) =>
                  void report(window.swarm.mcp.setToolOverride(server.id, t.name, { enabled: v, risk: t.risk }))
                }
              />
              <span
                className={
                  t.enabled
                    ? 'flex-1 truncate font-mono text-xs'
                    : 'flex-1 truncate font-mono text-muted-foreground text-xs'
                }
              >
                {t.name}
              </span>
              <NativeSelect
                onChange={(e) =>
                  void report(
                    window.swarm.mcp.setToolOverride(server.id, t.name, {
                      enabled: t.enabled,
                      risk: e.target.value as McpToolRisk,
                    })
                  )
                }
                size="sm"
                title="Risk level"
                value={t.risk}
              >
                {RISKS.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {r}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function McpServersView(): React.JSX.Element {
  const { servers } = useMcpServers()

  return (
    <div className="space-y-4">
      <SettingsHeader
        description="Connect Model Context Protocol servers to give agents extra tools. Tools default to medium risk (require confirmation); adjust per tool below."
        title="MCP Servers"
      />
      <AddServerForm />
      {servers.length === 0 ? (
        <p className="text-muted-foreground text-sm">No servers yet. Add one above.</p>
      ) : (
        servers.map((s) => <ServerCard key={s.id} server={s} />)
      )}
    </div>
  )
}
