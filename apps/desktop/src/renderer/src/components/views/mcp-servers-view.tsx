import { useEffect, useState } from 'react'
import type { McpConnectionState, McpServerConfig, McpToolRisk, McpTransport } from '@swarm/protocol'
import {
  Badge,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@swarm/ui'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { useMcpServers } from '@/hooks/use-mcp-servers'
import { cn } from '@/lib/utils'
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

/** Serialize the live config to the on-disk `{ mcpServers }` shape so the editor
 * box mirrors mcp-servers.json and round-trips losslessly through Save. Matches
 * the store's configToEntry: `type` key, defaults omitted, enabled only if false. */
function serializeServers(servers: McpServerConfig[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const s of servers) {
    const entry: Record<string, unknown> = { type: s.transport }
    if (s.transport === 'stdio') {
      if (s.command) entry.command = s.command
      if (s.args?.length) entry.args = s.args
      if (s.env && Object.keys(s.env).length) entry.env = s.env
      if (s.cwd) entry.cwd = s.cwd
    } else {
      if (s.url) entry.url = s.url
      if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers
    }
    if (s.enabled === false) entry.enabled = false
    if (s.toolOverrides && Object.keys(s.toolOverrides).length) entry.toolOverrides = s.toolOverrides
    mcpServers[s.name] = entry
  }
  return JSON.stringify({ mcpServers }, null, 2)
}

/** Parse the edited JSON into the desired server set keyed by name. Only the
 * standard `{ mcpServers: {...} }` wrapper is accepted (the shape we emit). */
function parseConfigForSync(text: string): Map<string, AddInput> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  if (!data || typeof data !== 'object') throw new Error('Expected a JSON object')
  const obj = data as Record<string, unknown>
  const map = (obj.mcpServers ?? obj.servers) as Record<string, unknown> | undefined
  if (!map || typeof map !== 'object') throw new Error('Expected a top-level "mcpServers" object')
  const out = new Map<string, AddInput>()
  for (const [name, cfg] of Object.entries(map)) {
    const raw = (cfg ?? {}) as Record<string, unknown>
    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true
    const toolOverrides =
      raw.toolOverrides && typeof raw.toolOverrides === 'object'
        ? (raw.toolOverrides as AddInput['toolOverrides'])
        : undefined
    out.set(name, { ...coerceServer(name, raw), enabled, toolOverrides })
  }
  return out
}

/** A patch carrying every optional field (undefined for absent ones) so the
 * merge in service.update acts as a full replace — dropping a field takes effect. */
function toFullPatch(cfg: AddInput): Omit<McpServerConfig, 'id'> {
  return {
    name: cfg.name,
    transport: cfg.transport,
    enabled: cfg.enabled,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
    url: cfg.url,
    headers: cfg.headers,
    toolOverrides: cfg.toolOverrides,
  }
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

/**
 * Editable JSON view of the whole MCP config. The box always reflects the live
 * mcp-servers.json (so it persists across dialog close + app restart for free);
 * Save diffs the edited JSON against the current servers and adds new ones,
 * updates changed ones, and removes those the JSON no longer lists.
 */
function JsonConfigForm(): React.JSX.Element {
  const { servers } = useMcpServers()
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Mirror the live config while the user isn't mid-edit. Dropping `dirty` after
  // a save reseeds the box from the now-canonical config (normalizing format).
  useEffect(() => {
    if (!dirty) setText(serializeServers(servers))
  }, [servers, dirty])

  const save = async (): Promise<void> => {
    let desired: Map<string, AddInput>
    try {
      desired = parseConfigForSync(text)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid config')
      return
    }
    setSaving(true)
    try {
      const byName = new Map(servers.map((s) => [s.name, s]))
      let added = 0
      let updated = 0
      let removed = 0
      let failed = 0
      const fail = (name: string, msg?: string): void => {
        failed++
        toast.error(`${name}: ${msg ?? 'failed'}`)
      }
      // Remove servers the edited JSON no longer lists.
      for (const s of servers) {
        if (desired.has(s.name)) continue
        const r = await window.swarm.mcp.remove(s.id)
        if (r.ok) removed++
        else fail(s.name, r.message)
      }
      // Add new servers; update only the ones whose JSON actually changed.
      for (const [name, cfg] of desired) {
        const existing = byName.get(name)
        if (!existing) {
          const r = await window.swarm.mcp.add(cfg)
          if (r.ok) added++
          else fail(name, r.message)
        } else if (serializeServers([existing]) !== serializeServers([{ ...cfg, id: existing.id }])) {
          const r = await window.swarm.mcp.update(existing.id, toFullPatch(cfg))
          if (r.ok) updated++
          else fail(name, r.message)
        }
      }
      if (failed === 0) {
        toast.success(`Saved · ${added} added, ${updated} updated, ${removed} removed`)
        setDirty(false)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        className="min-h-40 font-mono text-xs"
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
        }}
        placeholder={JSON_PLACEHOLDER}
        spellCheck={false}
        value={text}
      />
      <div className="flex justify-end gap-2">
        <Button disabled={!dirty || saving} onClick={() => setDirty(false)} variant="ghost">
          Revert
        </Button>
        <Button className="gap-1.5" disabled={!dirty || saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Save
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
      <h3 className="mb-3 font-medium text-sm">Add or edit servers</h3>
      {/* The shared Tabs root defaults to a flex ROW (its `data-horizontal:flex-col`
          never matches the `data-orientation` attribute), so stack explicitly to
          keep the JSON/Form switch on its own line above the inputs instead of
          beside them. */}
      <Tabs className="flex-col gap-3" defaultValue="json">
        <TabsList>
          <TabsTrigger value="json">JSON</TabsTrigger>
          <TabsTrigger value="manual">Form</TabsTrigger>
        </TabsList>
        <TabsContent value="json">
          <JsonConfigForm />
        </TabsContent>
        <TabsContent value="manual">
          <ManualForm />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ServerCard({
  server,
  expanded,
  onToggle,
}: {
  server: McpServerConfig
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { statusById } = useMcpServers()
  const status = statusById.get(server.id)
  const state: McpConnectionState = status?.state ?? (server.enabled ? 'connecting' : 'idle')
  const badge = STATE_BADGE[state]
  const toolCount = status?.tools.length ?? 0
  const target =
    server.transport === 'stdio' ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim() : server.url

  return (
    // The open card spans the full row so the tool list has room; collapsed
    // cards stay uniform in the grid.
    <div className={cn('rounded-xl border bg-card p-4', expanded && 'sm:col-span-2 lg:col-span-3')}>
      <div className="flex items-center gap-3">
        <button className="min-w-0 flex-1 text-left" onClick={onToggle} type="button">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{server.name}</span>
            <Badge className={badge.className} variant="secondary">
              {state === 'connecting' && <Loader2 className="mr-1 size-3 animate-spin" />}
              {badge.label}
            </Badge>
            <span className="text-muted-foreground text-xs">{server.transport}</span>
          </div>
          <p className="truncate text-muted-foreground text-xs">{target}</p>
          {toolCount > 0 && <span className="text-muted-foreground text-xs">{toolCount} tools</span>}
        </button>
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

      {expanded && status && status.tools.length > 0 && (
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
  const [expanded, setExpanded] = useState<string | null>(null)

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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s) => (
            <ServerCard
              expanded={expanded === s.id}
              key={s.id}
              onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
              server={s}
            />
          ))}
        </div>
      )}
    </div>
  )
}
