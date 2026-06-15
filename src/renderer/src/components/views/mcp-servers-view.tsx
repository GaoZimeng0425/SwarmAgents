import { useState } from 'react'
import type { McpConnectionState, McpServerConfig, McpToolRisk, McpTransport } from '@shared/types/mcp'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useMcpServers } from '@/hooks/use-mcp-servers'

const RISKS: McpToolRisk[] = ['low', 'medium', 'high']

const STATE_BADGE: Record<McpConnectionState, { label: string; className: string }> = {
  idle: { label: 'Disabled', className: 'bg-muted text-muted-foreground' },
  connecting: { label: 'Connecting', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  connected: { label: 'Connected', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  error: { label: 'Error', className: 'bg-destructive/15 text-destructive' },
}

const parseArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean)
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

async function report(p: Promise<{ ok: boolean; message?: string }>, okMsg?: string): Promise<void> {
  const r = await p
  if (!r.ok) toast.error(r.message ?? 'Operation failed')
  else if (okMsg) toast.success(okMsg)
}

function AddServerForm(): React.JSX.Element {
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
    const input =
      transport === 'stdio'
        ? { ...base, command: command.trim(), args: parseArgs(args), env: parseKeyVals(envText) }
        : { ...base, url: url.trim(), headers: parseKeyVals(headersText) }
    const r = await window.swarm.mcp.add(input)
    if (!r.ok) {
      toast.error(r.message)
      return
    }
    toast.success(`Added "${name.trim()}"`)
    setName('')
    setCommand('')
    setArgs('')
    setUrl('')
    setEnvText('')
    setHeadersText('')
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 font-medium text-sm">Add a server</h3>
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
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h2 className="font-semibold text-xl">MCP Servers</h2>
        <p className="text-muted-foreground text-sm">
          Connect Model Context Protocol servers to give agents extra tools. Tools default to medium risk (require
          confirmation); adjust per tool below.
        </p>
      </div>
      <AddServerForm />
      {servers.length === 0 ? (
        <p className="text-muted-foreground text-sm">No servers yet. Add one above.</p>
      ) : (
        servers.map((s) => <ServerCard key={s.id} server={s} />)
      )}
    </div>
  )
}
