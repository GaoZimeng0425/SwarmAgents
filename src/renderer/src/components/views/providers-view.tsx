import { useState } from 'react'

import type { ProviderId, ProvidersStateView } from '@shared/types/provider'
import type { ProvidersTestResult } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProviders } from '@/hooks/use-providers'

const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const
const OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'] as const

const MODEL_OPTIONS: Record<ProviderId, readonly string[]> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
}

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

export function ProvidersView(): React.JSX.Element {
  const { state, decryptFailed } = useProviders()

  return (
    <div className="max-w-2xl space-y-6">
      {decryptFailed && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          Saved keys could not be decrypted on this machine. Re-enter them to continue.
        </div>
      )}

      <div>
        <h2 className="text-lg font-medium">Providers</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure provider API keys. Keys are encrypted at rest using the system Keychain.
        </p>
      </div>

      <ActiveProvider state={state} />

      <hr className="border-border" />

      <ProviderRow id="anthropic" state={state} />

      <hr className="border-border" />

      <ProviderRow id="openai" state={state} />
    </div>
  )
}

function ActiveProvider({ state }: { state: ProvidersStateView }): React.JSX.Element {
  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value as ProviderId
    void window.swarm.providers.setActive(next)
  }
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Active provider</div>
      <div className="flex gap-4">
        {(['anthropic', 'openai'] as const).map((p) => (
          <label key={p} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="active-provider"
              value={p}
              checked={state.active === p}
              onChange={onChange}
            />
            {LABEL[p]}
          </label>
        ))}
      </div>
    </div>
  )
}

function ProviderRow({
  id,
  state,
}: {
  id: ProviderId
  state: ProvidersStateView
}): React.JSX.Element {
  const row = state.providers[id]
  const hasKey = row?.hasKey ?? false
  const currentModel = row?.model ?? MODEL_OPTIONS[id][0]
  const [draftKey, setDraftKey] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProvidersTestResult | null>(null)

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    const r = await window.swarm.providers.setKey(id, draftKey)
    setSaving(false)
    if (r.ok) {
      setDraftKey('')
      return
    }
    setSaveError(r.message)
  }

  const clear = async (): Promise<void> => {
    const decision = await window.swarm.showConfirm({
      title: `Remove ${LABEL[id]} API key?`,
      message: 'This will clear the stored key from disk.',
      risk: 'medium',
      buttons: [
        { label: 'Remove', role: 'grant', destructive: true },
        { label: 'Cancel', role: 'deny' },
      ],
    })
    if (decision !== 'grant') return
    await window.swarm.providers.clearKey(id)
    setTestResult(null)
  }

  const onModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    void window.swarm.providers.setModel(id, e.target.value)
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    const r = await window.swarm.providers.test(id)
    setTesting(false)
    setTestResult(r)
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">{LABEL[id]}</div>

      <div className="flex items-center gap-2">
        <label className="w-20 text-xs text-muted-foreground">API key</label>
        <Input
          type="password"
          value={draftKey}
          placeholder={hasKey ? '••••••••••••••••' : ''}
          onChange={(e) => setDraftKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={saving}
          className="flex-1"
        />
        <Button
          onClick={() => {
            void save()
          }}
          disabled={saving || draftKey.length === 0}
          size="sm"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="ml-22 flex items-center gap-3 text-xs">
        <span className={hasKey ? 'text-foreground' : 'text-muted-foreground'}>
          {hasKey ? 'Key set ✓' : 'Not set'}
        </span>
        {hasKey && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void clear()
            }}
          >
            Clear
          </Button>
        )}
        {saveError && <span className="text-red-500">{saveError}</span>}
      </div>

      <div className="flex items-center gap-2">
        <label className="w-20 text-xs text-muted-foreground">Model</label>
        <select
          value={currentModel}
          onChange={onModelChange}
          disabled={!hasKey}
          className="rounded border border-input bg-background px-2 py-1 text-sm"
        >
          {MODEL_OPTIONS[id].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => {
            void runTest()
          }}
          disabled={!hasKey || testing}
          size="sm"
          variant="outline"
        >
          {testing ? 'Testing…' : 'Test'}
        </Button>
        {testResult && <TestStatus result={testResult} />}
        {!hasKey && !testing && (
          <span className="text-xs text-muted-foreground">— set a key first</span>
        )}
      </div>
    </div>
  )
}

function TestStatus({ result }: { result: ProvidersTestResult }): React.JSX.Element {
  if (result.ok) {
    return <span className="text-xs text-green-600">✓ {result.latencyMs} ms</span>
  }
  if (result.code === 'unauthorized') {
    return <span className="text-xs text-red-500">Invalid key</span>
  }
  if (result.code === 'rate_limited') {
    return <span className="text-xs text-amber-600">Rate-limited (key is valid)</span>
  }
  if (result.code === 'network') {
    return <span className="text-xs text-muted-foreground">Network error</span>
  }
  return (
    <span className="text-xs text-muted-foreground" title={result.message}>
      {result.message}
    </span>
  )
}
