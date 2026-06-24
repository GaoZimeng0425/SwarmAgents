import { useEffect, useRef, useState } from 'react'
import {
  type ApiStyle,
  BUILTIN_DEFS,
  BUILTIN_IDS,
  isBuiltinId,
  type ModelThinkingLevel,
  modelSuggestionsFor,
  type ProvidersStateView,
  type ProviderView,
  providerViewById,
} from '@shared/types/provider'
import type { ProvidersTestResult } from '@shared/types/ui'
import { Bot, Box, Download, Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useProviders } from '@/hooks/use-providers'
import { cn } from '@/lib/utils'

// Display name for any provider id: the configured row's name, else the built-in
// default, else a generic fallback (an unconfigured custom id should never reach
// here). The only place the UI needs to name an unconfigured provider.
function displayName(state: ProvidersStateView, id: string): string {
  const row = providerViewById(state, id)
  if (row) return row.name
  return isBuiltinId(id) ? BUILTIN_DEFS[id].name : 'Custom'
}

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

// Right-pane selection: a provider id, the literal 'add' (showing the create
// form), or null (nothing selected yet — only before the first state arrives).
type Selection = string | 'add' | null

export function ProvidersView(): React.JSX.Element {
  const { state, decryptFailed, refetch } = useProviders()
  const customs = state.providers.filter((p) => !p.registry)
  const [selected, setSelected] = useState<Selection>(null)
  const didInit = useRef(false)

  // Keep a valid selection: recover when the current one disappears (e.g. a
  // custom provider was deleted), and on the first real state, jump to the
  // active (default) provider rather than the empty-state placeholder.
  useEffect(() => {
    if (selected !== 'add') {
      const exists = selected != null && (isBuiltinId(selected) || customs.some((p) => p.id === selected))
      if (!exists) {
        setSelected(state.active ?? customs[0]?.id ?? BUILTIN_IDS[0] ?? null)
        return
      }
    }
    if (!didInit.current && (state.active != null || state.providers.length > 0)) {
      didInit.current = true
      if (state.active != null) setSelected(state.active)
    }
  }, [state, selected, customs])

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-lg">模型设置</h2>
          <p className="mt-1 text-muted-foreground text-sm">管理自定义模型供应商，配置后可在聊天时选择使用。</p>
        </div>
        <Button onClick={refetch} size="icon-sm" title="刷新" variant="ghost">
          <RefreshCw />
        </Button>
      </div>

      {decryptFailed && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          Saved keys could not be decrypted on this machine. Re-enter them to continue.
        </div>
      )}

      <div className="flex min-h-[26rem] overflow-hidden rounded-xl border">
        <nav className="w-60 shrink-0 space-y-4 overflow-y-auto border-r bg-muted/20 p-3">
          <ListGroup label="内置">
            {BUILTIN_IDS.map((bid) => (
              <ProviderRow
                configured={providerViewById(state, bid)?.hasKey ?? false}
                icon={<Bot className="size-4 shrink-0 opacity-70" />}
                key={bid}
                label={BUILTIN_DEFS[bid].name}
                onClick={() => setSelected(bid)}
                selected={selected === bid}
              />
            ))}
          </ListGroup>

          <ListGroup label="自定义供应商">
            {customs.map((p) => (
              <ProviderRow
                configured={p.hasKey}
                icon={<Box className="size-4 shrink-0 opacity-70" />}
                key={p.id}
                label={p.name}
                onClick={() => setSelected(p.id)}
                selected={selected === p.id}
              />
            ))}
            <button
              className={cn(
                'flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-left text-sm transition-colors',
                selected === 'add'
                  ? 'border-border bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
              onClick={() => setSelected('add')}
              type="button"
            >
              <Plus className="size-4 shrink-0" /> 添加供应商
            </button>
          </ListGroup>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {selected === 'add' ? (
            <AddProviderForm onCancel={() => setSelected(state.active ?? null)} onCreated={(id) => setSelected(id)} />
          ) : selected ? (
            <ProviderDetail id={selected} key={selected} onDeleted={() => setSelected(null)} state={state} />
          ) : (
            <p className="text-muted-foreground text-sm">选择左侧的供应商进行配置</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ListGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="px-1 text-muted-foreground text-xs">{label}</div>
      {children}
    </div>
  )
}

function ProviderRow({
  icon,
  label,
  configured,
  selected,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  configured: boolean
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
        selected
          ? 'border-border bg-accent text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn('size-2 shrink-0 rounded-full', configured ? 'bg-emerald-500' : 'bg-muted-foreground/30')} />
    </button>
  )
}

// ── Detail (built-in or custom) ──────────────────────────────────────────────
function ProviderDetail({
  id,
  state,
  onDeleted,
}: {
  id: string
  state: ProvidersStateView
  onDeleted: () => void
}): React.JSX.Element {
  const isBuiltin = isBuiltinId(id)
  const row = providerViewById(state, id)
  const name = displayName(state, id)
  const isActive = state.active === id

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <NameHeader id={id} isBuiltin={isBuiltin} name={name} />
          {isActive ? (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-medium text-emerald-600 text-xs dark:text-emerald-400">
              默认
            </span>
          ) : (
            <Button onClick={() => void window.swarm.providers.setActive(id)} size="sm" variant="outline">
              设为默认
            </Button>
          )}
        </div>
        {!isBuiltin && <DeleteButton id={id} name={name} onDeleted={onDeleted} />}
      </div>

      <BaseUrlField id={id} isBuiltin={isBuiltin} value={row?.baseUrl ?? ''} />

      {!isBuiltin && <ApiStyleField id={id} value={row?.apiStyle ?? 'openai'} />}

      <KeyField hasKey={row?.hasKey ?? false} id={id} isBuiltin={isBuiltin} />

      {row && <ModelList id={id} isBuiltin={isBuiltin} row={row} />}

      {row && row.thinkingLevels.length > 1 && <ThinkingField id={id} row={row} />}

      {row && <TestRow id={id} />}
    </div>
  )
}

// Provider name with an inline rename affordance (pencil) for custom providers.
function NameHeader({ id, name, isBuiltin }: { id: string; name: string; isBuiltin: boolean }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== name) void window.swarm.providers.renameCustomProvider(id, next)
  }

  if (editing) {
    return (
      <Input
        autoFocus
        className="h-8 w-56"
        onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(name)
            setEditing(false)
          }
        }}
        value={draft}
      />
    )
  }

  return (
    <>
      <h2 className="truncate font-medium text-lg">{name}</h2>
      {!isBuiltin && (
        <button
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            setDraft(name)
            setEditing(true)
          }}
          title="重命名"
          type="button"
        >
          <Pencil className="size-4" />
        </button>
      )}
    </>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">{label}</div>
      {children}
    </div>
  )
}

function ApiStyleField({ id, value }: { id: string; value: ApiStyle }): React.JSX.Element {
  return (
    <Section label="API 格式">
      <Select
        onValueChange={(v) => {
          if (v) void window.swarm.providers.setApiStyle(id, v as ApiStyle)
        }}
        value={value}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="anthropic">Anthropic Messages (/v1/messages)</SelectItem>
          <SelectItem value="openai">OpenAI Chat Completions (/chat/completions)</SelectItem>
        </SelectContent>
      </Select>
    </Section>
  )
}

function KeyField({ id, hasKey, isBuiltin }: { id: string; hasKey: boolean; isBuiltin: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (!draft) return
    const r = await window.swarm.providers.setKey(id, draft)
    if (!r.ok) {
      setError(r.message)
      return
    }
    setError(null)
    setDraft('')
  }
  return (
    <Section label="API Key">
      <div className="relative">
        <Input
          className="pr-10"
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hasKey ? '•••••••••••••••• (saved) — type to replace' : '输入 API Key'}
          type={reveal ? 'text' : 'password'}
          value={draft}
        />
        <button
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setReveal((v) => !v)}
          tabIndex={-1}
          title={reveal ? '隐藏' : '显示'}
          type="button"
        >
          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <div className="flex gap-2">
        <Button disabled={!draft} onClick={() => void save()} size="sm">
          保存 Key
        </Button>
        {isBuiltin && hasKey && (
          <Button onClick={() => void window.swarm.providers.clearKey(id)} size="sm" variant="outline">
            清除
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </Section>
  )
}

function BaseUrlField({ id, value, isBuiltin }: { id: string; value: string; isBuiltin: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  return (
    <Section label={isBuiltin ? 'Base URL (可选)' : 'Base URL'}>
      <Input
        onBlur={() => {
          if (draft !== value) void window.swarm.providers.setBaseUrl(id, draft.trim() || null)
        }}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="https://api.example.com/v1"
        value={draft}
      />
    </Section>
  )
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function formatPrice(p: { inputPerM: number; outputPerM: number }): string {
  const fmt = (v: number) => `$${Number(v.toFixed(2))}`
  return `${fmt(p.inputPerM)} / ${fmt(p.outputPerM)}`
}

function ModelList({ id, row, isBuiltin }: { id: string; row: ProviderView; isBuiltin: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [fetching, setFetching] = useState(false)
  const suggestions = modelSuggestionsFor(id)
  const models = row.models

  const add = async (m: string): Promise<void> => {
    if (!m.trim()) return
    await window.swarm.providers.addCustomModel(id, m.trim())
    setDraft('')
  }

  const fetchInfo = async (): Promise<void> => {
    setFetching(true)
    const r = await window.swarm.providers.fetchModelInfo(id)
    setFetching(false)
    if (!r.ok) {
      toast.error(`拉取失败：${r.message}`)
      return
    }
    const tail = r.unmatched.length ? `；未匹配：${r.unmatched.join(', ')}` : ''
    toast.success(`已匹配 ${r.matched}/${r.total} 个模型${tail}`)
  }

  return (
    <Section label="模型列表">
      {!isBuiltin && (
        <div className="flex justify-end">
          <Button disabled={fetching} onClick={() => void fetchInfo()} size="sm" variant="outline">
            <Download className={cn('size-3.5', fetching && 'animate-pulse')} />
            {fetching ? '拉取中…' : '从 OpenRouter 拉取'}
          </Button>
        </div>
      )}
      <div className="space-y-1.5">
        {models.map((m) => (
          <ModelRow
            active={row.model === m}
            id={id}
            isBuiltin={isBuiltin}
            key={m}
            meta={row.modelMeta?.[m]}
            model={m}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          list={`models-${id}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add(draft)
            }
          }}
          placeholder="添加模型 id"
          value={draft}
        />
        <datalist id={`models-${id}`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button disabled={!draft.trim()} onClick={() => void add(draft)} variant="outline">
          <Plus /> 添加模型
        </Button>
      </div>
    </Section>
  )
}

function ModelRow({
  id,
  model,
  active,
  isBuiltin,
  meta,
}: {
  id: string
  model: string
  active: boolean
  isBuiltin: boolean
  meta: { contextWindow?: number; pricing?: { inputPerM: number; outputPerM: number } } | undefined
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta?.contextWindow != null ? String(meta.contextWindow) : '')

  const commit = (): void => {
    setEditing(false)
    const t = draft.trim()
    if (t === '') {
      if (meta?.contextWindow != null) void window.swarm.providers.setModelContextWindow(id, model, null)
      return
    }
    const n = Number(t)
    if (Number.isInteger(n) && n > 0 && n !== meta?.contextWindow)
      void window.swarm.providers.setModelContextWindow(id, model, n)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        active && 'border-primary/40 bg-primary/5'
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        onClick={() => void window.swarm.providers.setModel(id, model)}
        type="button"
      >
        <span
          className={cn(
            'size-3.5 shrink-0 rounded-full border',
            active ? 'border-[4.5px] border-primary' : 'border-muted-foreground/40'
          )}
        />
        <span className="truncate font-mono">{model}</span>
      </button>

      {/* Per-model context + price. Context is inline-editable for custom providers
          (so models missing from OpenRouter can be filled by hand). */}
      <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
        {meta?.pricing && <span className="tabular-nums">{formatPrice(meta.pricing)}</span>}
        {!isBuiltin &&
          (editing ? (
            <Input
              autoFocus
              className="h-6 w-24 text-xs"
              onBlur={commit}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') {
                  setDraft(meta?.contextWindow != null ? String(meta.contextWindow) : '')
                  setEditing(false)
                }
              }}
              placeholder="ctx"
              value={draft}
            />
          ) : (
            <button
              className="rounded px-1 hover:bg-accent hover:text-foreground"
              onClick={() => {
                setDraft(meta?.contextWindow != null ? String(meta.contextWindow) : '')
                setEditing(true)
              }}
              title="设置上下文窗口"
              type="button"
            >
              {meta?.contextWindow != null ? formatContext(meta.contextWindow) : '设置 ctx'}
            </button>
          ))}
      </div>

      {!active && (
        <button
          className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
          onClick={() => void window.swarm.providers.removeCustomModel(id, model)}
          title="移除"
          type="button"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function ThinkingField({ id, row }: { id: string; row: ProviderView }): React.JSX.Element {
  return (
    <Section label="推理深度">
      <Select
        onValueChange={(v) => {
          if (v) void window.swarm.providers.setThinkingLevel(id, v as ModelThinkingLevel)
        }}
        value={row.thinkingLevel}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {row.thinkingLevels.map((l) => (
            <SelectItem key={l} value={l}>
              {THINKING_LABELS[l]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Section>
  )
}

function TestRow({ id }: { id: string }): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProvidersTestResult | null>(null)
  const run = async (): Promise<void> => {
    setTesting(true)
    setResult(await window.swarm.providers.test(id))
    setTesting(false)
  }
  return (
    <div className="space-y-2">
      <Button disabled={testing} onClick={() => void run()} variant="outline">
        {testing ? '测试中…' : '测试连接'}
      </Button>
      {result &&
        (result.ok ? (
          <p className="text-emerald-600 text-xs dark:text-emerald-400">
            ✓ {result.latencyMs}ms · {result.url}
          </p>
        ) : (
          <p className="text-destructive text-xs">✗ {result.message}</p>
        ))}
    </div>
  )
}

function DeleteButton({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const confirmDelete = async (): Promise<void> => {
    const r = await window.swarm.providers.removeCustomProvider(id)
    if (r.ok) {
      onDeleted()
      setOpen(false)
    }
  }
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={
          <Button
            className="text-muted-foreground hover:text-destructive"
            size="icon-sm"
            title="删除供应商"
            variant="ghost"
          />
        }
      >
        <Trash2 className="size-4" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除供应商 {name}?</AlertDialogTitle>
          <AlertDialogDescription>这会移除该供应商及其 API Key。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirmDelete()} variant="destructive">
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── Add custom provider form ─────────────────────────────────────────────────
function AddProviderForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (id: string) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [apiStyle, setApiStyle] = useState<ApiStyle>('anthropic')
  const [models, setModels] = useState<string[]>([])
  const [modelDraft, setModelDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const addModel = (): void => {
    const m = modelDraft.trim()
    if (m && !models.includes(m)) setModels([...models, m])
    setModelDraft('')
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.swarm.providers.addCustomProvider({
      name,
      apiKey,
      apiStyle,
      baseUrl: baseUrl.trim() || null,
      models,
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    onCreated(r.id)
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="font-medium text-lg">添加模型供应商</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          配置一个完全自定义的 API 端点和初始模型。Key 用系统 Keychain 加密存储。
        </p>
      </div>

      <Section label="名称">
        <Input onChange={(e) => setName(e.target.value)} placeholder="如：智谱 GLM" value={name} />
      </Section>
      <Section label="Base URL">
        <Input onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" value={baseUrl} />
      </Section>
      <Section label="API Key">
        <div className="relative">
          <Input
            className="pr-10"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="输入 API Key"
            type={reveal ? 'text' : 'password'}
            value={apiKey}
          />
          <button
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setReveal((v) => !v)}
            tabIndex={-1}
            title={reveal ? '隐藏' : '显示'}
            type="button"
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Section>
      <Section label="API 格式">
        <Select
          onValueChange={(v) => {
            if (v) setApiStyle(v as ApiStyle)
          }}
          value={apiStyle}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">Anthropic Messages (/v1/messages)</SelectItem>
            <SelectItem value="openai">OpenAI Chat Completions (/chat/completions)</SelectItem>
          </SelectContent>
        </Select>
      </Section>
      <Section label="模型列表">
        {models.length > 0 && (
          <div className="space-y-1.5">
            {models.map((m) => (
              <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm" key={m}>
                <span className="truncate font-mono">{m}</span>
                <button
                  className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => setModels(models.filter((x) => x !== m))}
                  title="移除"
                  type="button"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            onChange={(e) => setModelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addModel()
              }
            }}
            placeholder="模型 id，回车添加"
            value={modelDraft}
          />
          <Button disabled={!modelDraft.trim()} onClick={addModel} variant="outline">
            <Plus /> 添加模型
          </Button>
        </div>
      </Section>

      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button onClick={onCancel} variant="outline">
          取消
        </Button>
        <Button disabled={busy} onClick={() => void submit()}>
          保存
        </Button>
      </div>
    </div>
  )
}
