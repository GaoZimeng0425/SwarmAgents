import { useMemo, useState } from 'react'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  findProviderRowView,
  type ModelThinkingLevel,
  OPENAI_MODEL_SUGGESTIONS,
  type ProviderRowView,
  type ProvidersStateView,
} from '@shared/types/provider'
import type { ProvidersTestResult } from '@shared/types/ui'

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
import { useProviders } from '@/hooks/use-providers'

const ADD = '__add__'
const BUILTIN_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

export function ProvidersView(): React.JSX.Element {
  const { state, decryptFailed } = useProviders()
  const [selected, setSelected] = useState<string | null>(null)

  // Until the user picks, land on the active provider (or the first configured
  // one, else Anthropic). `selected === ADD` shows the add form.
  const current = selected ?? state.active ?? state.custom[0]?.id ?? 'anthropic'

  return (
    <div className="flex h-full gap-0">
      <Sidebar onAdd={() => setSelected(ADD)} onSelect={setSelected} selected={current} state={state} />
      <main className="min-w-0 flex-1 overflow-auto p-6">
        {decryptFailed && (
          <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            Saved keys could not be decrypted on this machine. Re-enter them to continue.
          </div>
        )}
        {current === ADD ? (
          <AddProviderForm onCreated={(id) => setSelected(id)} />
        ) : (
          <ProviderDetail id={current} key={current} onDeleted={() => setSelected('anthropic')} state={state} />
        )}
      </main>
    </div>
  )
}

function Dot({ on }: { on: boolean }): React.JSX.Element {
  return <span className={`size-2 rounded-full ${on ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} />
}

function Sidebar({
  state,
  selected,
  onSelect,
  onAdd,
}: {
  state: ProvidersStateView
  selected: string
  onSelect: (id: string) => void
  onAdd: () => void
}): React.JSX.Element {
  const item = (id: string, label: string, configured: boolean): React.JSX.Element => (
    <button
      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-accent ${
        selected === id ? 'bg-accent' : ''
      }`}
      key={id}
      onClick={() => onSelect(id)}
      type="button"
    >
      <span className="truncate">{label}</span>
      <Dot on={state.active === id || configured} />
    </button>
  )

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-1 border-r p-3">
      <div className="px-3 py-1 text-muted-foreground text-xs">内置</div>
      {item('anthropic', 'Anthropic', state.builtins.anthropic !== null)}
      {item('openai', 'OpenAI', state.builtins.openai !== null)}

      <div className="px-3 pt-3 pb-1 text-muted-foreground text-xs">自定义供应商</div>
      {state.custom.map((c) => item(c.id, c.name, true))}

      <button
        className={`mt-1 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm hover:bg-accent ${
          selected === ADD ? 'bg-accent' : ''
        }`}
        onClick={onAdd}
        type="button"
      >
        <span className="text-base leading-none">+</span> 添加供应商
      </button>
    </aside>
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
  const isBuiltin = id === 'anthropic' || id === 'openai'
  const row = findProviderRowView(state, id)
  const name = isBuiltin ? BUILTIN_LABEL[id] : (state.custom.find((c) => c.id === id)?.name ?? 'Custom')
  const isActive = state.active === id

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="font-medium text-lg">{name}</h2>
          {isActive ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-600 text-xs dark:text-emerald-400">
              已启用
            </span>
          ) : (
            <Button onClick={() => void window.swarm.providers.setActive(id)} size="sm" variant="outline">
              启用
            </Button>
          )}
        </div>
        {!isBuiltin && <DeleteButton id={id} name={name} onDeleted={onDeleted} />}
      </div>

      {!isBuiltin && <NameField id={id} value={name} />}
      {!isBuiltin && <ApiStyleField id={id} value={row?.apiStyle ?? 'openai'} />}

      <KeyField hasKey={row?.hasKey ?? false} id={id} isBuiltin={isBuiltin} />

      <BaseUrlField id={id} isBuiltin={isBuiltin} value={row?.baseUrl ?? ''} />

      {row && <ModelList id={id} isBuiltin={isBuiltin} row={row} />}

      {row && row.thinkingLevels.length > 1 && <ThinkingField id={id} row={row} />}

      {!isBuiltin && row && <ContextWindowField id={id} value={row.contextWindow} />}

      {row && <TestRow id={id} />}
    </div>
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

function NameField({ id, value }: { id: string; value: string }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  return (
    <Section label="名称">
      <Input
        onBlur={() => {
          if (draft.trim() && draft !== value) void window.swarm.providers.renameCustomProvider(id, draft.trim())
        }}
        onChange={(e) => setDraft(e.target.value)}
        value={draft}
      />
    </Section>
  )
}

function ApiStyleField({ id, value }: { id: string; value: ApiStyle }): React.JSX.Element {
  return (
    <Section label="API 格式">
      <select
        className="w-full rounded border bg-background px-3 py-2 text-sm"
        onChange={(e) => void window.swarm.providers.setApiStyle(id, e.target.value as ApiStyle)}
        value={value}
      >
        <option value="anthropic">Anthropic Messages (/v1/messages)</option>
        <option value="openai">OpenAI Chat Completions (/chat/completions)</option>
      </select>
    </Section>
  )
}

function KeyField({ id, hasKey, isBuiltin }: { id: string; hasKey: boolean; isBuiltin: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState('')
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
      <div className="flex gap-2">
        <Input
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hasKey ? '•••••••• (saved) — type to replace' : '输入 API Key'}
          type="password"
          value={draft}
        />
        <Button disabled={!draft} onClick={() => void save()}>
          Save
        </Button>
        {isBuiltin && hasKey && (
          <Button onClick={() => void window.swarm.providers.clearKey(id)} variant="outline">
            Clear
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

function ModelList({
  id,
  row,
  isBuiltin,
}: {
  id: string
  row: ProviderRowView
  isBuiltin: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const suggestions = isBuiltin ? (id === 'anthropic' ? ANTHROPIC_MODEL_SUGGESTIONS : OPENAI_MODEL_SUGGESTIONS) : []
  const models = useMemo(() => [...new Set([row.model, ...(row.customModels ?? [])])], [row.model, row.customModels])

  const add = async (m: string): Promise<void> => {
    if (!m.trim()) return
    await window.swarm.providers.addCustomModel(id, m.trim())
    setDraft('')
  }

  return (
    <Section label="模型列表">
      <div className="space-y-1">
        {models.map((m) => (
          <div className="flex items-center justify-between rounded border px-3 py-2 text-sm" key={m}>
            <label className="flex items-center gap-2">
              <input
                checked={row.model === m}
                onChange={() => void window.swarm.providers.setModel(id, m)}
                type="radio"
              />
              <span className="font-mono">{m}</span>
            </label>
            {row.model !== m && (
              <button
                className="text-muted-foreground text-xs hover:text-destructive"
                onClick={() => void window.swarm.providers.removeCustomModel(id, m)}
                type="button"
              >
                移除
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          list={`models-${id}`}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="添加模型 id"
          value={draft}
        />
        <datalist id={`models-${id}`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Button disabled={!draft.trim()} onClick={() => void add(draft)}>
          + 添加模型
        </Button>
      </div>
    </Section>
  )
}

function ThinkingField({ id, row }: { id: string; row: ProviderRowView }): React.JSX.Element {
  return (
    <Section label="推理深度">
      <select
        className="w-full rounded border bg-background px-3 py-2 text-sm"
        onChange={(e) => void window.swarm.providers.setThinkingLevel(id, e.target.value as ModelThinkingLevel)}
        value={row.thinkingLevel}
      >
        {row.thinkingLevels.map((l) => (
          <option key={l} value={l}>
            {THINKING_LABELS[l]}
          </option>
        ))}
      </select>
    </Section>
  )
}

function ContextWindowField({ id, value }: { id: string; value: number | undefined }): React.JSX.Element {
  const [draft, setDraft] = useState(value != null ? String(value) : '')
  return (
    <Section label="上下文窗口 (tokens, 可选)">
      <Input
        onBlur={() => {
          const t = draft.trim()
          if (t === '') void window.swarm.providers.setContextWindow(id, null)
          else {
            const n = Number(t)
            if (Number.isInteger(n) && n > 0) void window.swarm.providers.setContextWindow(id, n)
          }
        }}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="200000"
        value={draft}
      />
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
      <AlertDialogTrigger render={<Button size="sm" variant="outline" />}>删除</AlertDialogTrigger>
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
function AddProviderForm({ onCreated }: { onCreated: (id: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
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
        <Input onChange={(e) => setApiKey(e.target.value)} placeholder="输入 API Key" type="password" value={apiKey} />
      </Section>
      <Section label="API 格式">
        <select
          className="w-full rounded border bg-background px-3 py-2 text-sm"
          onChange={(e) => setApiStyle(e.target.value as ApiStyle)}
          value={apiStyle}
        >
          <option value="anthropic">Anthropic Messages (/v1/messages)</option>
          <option value="openai">OpenAI Chat Completions (/chat/completions)</option>
        </select>
      </Section>
      <Section label="模型列表">
        {models.length > 0 && (
          <div className="space-y-1">
            {models.map((m) => (
              <div className="flex items-center justify-between rounded border px-3 py-2 text-sm" key={m}>
                <span className="font-mono">{m}</span>
                <button
                  className="text-muted-foreground text-xs hover:text-destructive"
                  onClick={() => setModels(models.filter((x) => x !== m))}
                  type="button"
                >
                  移除
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
            + 添加模型
          </Button>
        </div>
      </Section>

      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button disabled={busy} onClick={() => void submit()}>
        添加供应商
      </Button>
    </div>
  )
}
