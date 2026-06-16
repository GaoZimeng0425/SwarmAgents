import { useEffect, useMemo, useState } from 'react'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  DEFAULT_CONTEXT_WINDOW,
  OPENAI_MODEL_SUGGESTIONS,
  type ProviderId,
  type ProvidersStateView,
} from '@shared/types/provider'
import type { ProvidersTestResult } from '@shared/types/ui'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProviders } from '@/hooks/use-providers'

const STYLE_SUGGESTIONS: Record<ApiStyle, readonly string[]> = {
  anthropic: ANTHROPIC_MODEL_SUGGESTIONS,
  openai: OPENAI_MODEL_SUGGESTIONS,
}

const LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  custom: 'Custom',
}

const BASE_URL_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: 'https://api.anthropic.com (default)',
  openai: 'https://api.openai.com/v1 (default)',
  custom: 'https://open.bigmodel.cn/api/paas/v4',
}

const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'custom'] as const

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
        <h2 className="font-medium text-lg">Providers</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Configure provider API keys. Keys are encrypted at rest using the system Keychain.
        </p>
      </div>

      <ActiveProvider state={state} />

      <hr className="border-border" />

      <ProviderRow id="anthropic" state={state} />

      <hr className="border-border" />

      <ProviderRow id="openai" state={state} />

      <hr className="border-border" />

      <ProviderRow id="custom" state={state} />
    </div>
  )
}

function ActiveProvider({ state }: { state: ProvidersStateView }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const onChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const next = e.target.value as ProviderId
    setError(null)
    const r = await window.swarm.providers.setActive(next)
    if (!r.ok) setError(`${next}: ${r.message}`)
  }
  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">Active provider</div>
      <div className="flex gap-4">
        {PROVIDER_IDS.map((p) => (
          <label className="flex items-center gap-2 text-sm" key={p}>
            <input
              checked={state.active === p}
              name="active-provider"
              onChange={(e) => {
                void onChange(e)
              }}
              type="radio"
              value={p}
            />
            {LABEL[p]}
          </label>
        ))}
      </div>
      {error && <div className="text-red-500 text-xs">{error}</div>}
    </div>
  )
}

const ADD_CUSTOM_SENTINEL = '__add_custom__'

function ProviderRow({ id, state }: { id: ProviderId; state: ProvidersStateView }): React.JSX.Element {
  const row = state.providers[id]
  const hasKey = row?.hasKey ?? false
  const serverApiStyle: ApiStyle = id === 'custom' ? (row?.apiStyle ?? 'openai') : (id as ApiStyle)
  const serverBaseUrl = row?.baseUrl ?? ''
  const serverContextWindow = row?.contextWindow
  const serverCustomModels = useMemo(() => row?.customModels ?? [], [row?.customModels])
  const [draftKey, setDraftKey] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProvidersTestResult | null>(null)

  // Every editable field is held as a local draft so the user can fill the
  // entire form BEFORE a key exists, then a single "Save" commits everything.
  // Once a key is saved, edits commit immediately (per-field), like before.
  const [modelError, setModelError] = useState<string | null>(null)
  const [baseUrlDraft, setBaseUrlDraft] = useState(serverBaseUrl)
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null)
  const [contextWindowDraft, setContextWindowDraft] = useState(
    serverContextWindow != null ? String(serverContextWindow) : ''
  )
  const [contextWindowError, setContextWindowError] = useState<string | null>(null)
  const [apiStyleDraft, setApiStyleDraft] = useState<ApiStyle>(serverApiStyle)
  const [customModelsDraft, setCustomModelsDraft] = useState<string[]>(serverCustomModels)

  const apiStyle = apiStyleDraft
  const suggestions = STYLE_SUGGESTIONS[apiStyle]
  const serverModel = row?.model ?? suggestions[0]
  const [modelDraft, setModelDraft] = useState(serverModel)
  const currentModel = modelDraft
  const isCurrentModelCustom = customModelsDraft.includes(currentModel)

  // "Add custom model" inline editor.
  const [addingCustom, setAddingCustom] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)

  // Sync local drafts back to server state. These only fire when the server
  // value actually changes, so the brief moment between setKey() and the
  // subsequent setApiStyle/setBaseUrl/addCustomModel/setModel calls in save()
  // does NOT wipe the drafts (server values are unchanged during that gap).
  useEffect(() => {
    setBaseUrlDraft(serverBaseUrl)
  }, [serverBaseUrl])
  useEffect(() => {
    setContextWindowDraft(serverContextWindow != null ? String(serverContextWindow) : '')
  }, [serverContextWindow])
  useEffect(() => {
    setApiStyleDraft(serverApiStyle)
  }, [serverApiStyle])
  useEffect(() => {
    setCustomModelsDraft(serverCustomModels)
  }, [serverCustomModels])
  useEffect(() => {
    setModelDraft(serverModel)
  }, [serverModel])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    // Snapshot all drafts now — the state broadcast that follows setKey() can
    // race ahead and fire the useEffects above before we commit them.
    const baseUrlSnapshot = baseUrlDraft.trim()
    const contextWindowSnapshot = contextWindowDraft.trim()
    const apiStyleSnapshot = apiStyleDraft
    const customsSnapshot = customModelsDraft
    const modelSnapshot = modelDraft
    const r = await window.swarm.providers.setKey(id, draftKey)
    if (!r.ok) {
      setSaving(false)
      setSaveError(r.message)
      return
    }
    setDraftKey('')
    // Order matters:
    //   1. apiStyle (custom only) — affects which model is "valid"
    //   2. customModels — must be in the saved list before setModel can pick one
    //   3. setModel — the chosen one
    //   4. baseUrl — independent
    if (id === 'custom' && apiStyleSnapshot !== serverApiStyle) {
      const rs = await window.swarm.providers.setApiStyle(id, apiStyleSnapshot)
      if (!rs.ok) setModelError(rs.message)
    }
    for (const m of customsSnapshot) {
      if (!serverCustomModels.includes(m)) {
        const ra = await window.swarm.providers.addCustomModel(id, m)
        if (!ra.ok) {
          setModelError(ra.message)
          break
        }
      }
    }
    if (modelSnapshot !== serverModel) {
      const rm = await window.swarm.providers.setModel(id, modelSnapshot)
      if (!rm.ok) setModelError(rm.message)
    }
    if (baseUrlSnapshot.length > 0 && baseUrlSnapshot !== serverBaseUrl) {
      const rb = await window.swarm.providers.setBaseUrl(id, baseUrlSnapshot)
      if (!rb.ok) setBaseUrlError(rb.message)
    }
    if (id === 'custom' && contextWindowSnapshot.length > 0) {
      const n = Number(contextWindowSnapshot)
      if (Number.isInteger(n) && n > 0) {
        const rc = await window.swarm.providers.setContextWindow(id, n)
        if (!rc.ok) setContextWindowError(rc.message)
      } else {
        setContextWindowError('Must be a positive integer')
      }
    }
    setSaving(false)
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

  const onSelectModel = async (e: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const value = e.target.value
    if (value === ADD_CUSTOM_SENTINEL) {
      setAddingCustom(true)
      setCustomDraft('')
      setCustomError(null)
      return
    }
    if (value === modelDraft) return
    setModelDraft(value)
    setModelError(null)
    if (!hasKey) return // commit on save()
    const r = await window.swarm.providers.setModel(id, value)
    if (!r.ok) setModelError(r.message)
  }

  const commitCustom = async (): Promise<void> => {
    const trimmed = customDraft.trim()
    if (trimmed.length === 0) {
      setCustomError('model must not be empty')
      return
    }
    setCustomError(null)
    // Update local draft state first so the new model is visible immediately.
    if (!customModelsDraft.includes(trimmed)) {
      setCustomModelsDraft([...customModelsDraft, trimmed])
    }
    setModelDraft(trimmed)
    setAddingCustom(false)
    setCustomDraft('')
    if (!hasKey) return // committed by save()
    const add = await window.swarm.providers.addCustomModel(id, trimmed)
    if (!add.ok) {
      setCustomError(add.message)
      return
    }
    const set = await window.swarm.providers.setModel(id, trimmed)
    if (!set.ok) setModelError(set.message)
  }

  const removeCurrentCustom = async (): Promise<void> => {
    if (!isCurrentModelCustom) return
    const target = modelDraft
    const fallback = suggestions[0]
    setModelDraft(fallback)
    setCustomModelsDraft(customModelsDraft.filter((m) => m !== target))
    setModelError(null)
    if (!hasKey) return // committed by save() (the model just won't be re-added)
    const set = await window.swarm.providers.setModel(id, fallback)
    if (!set.ok) {
      setModelError(set.message)
      return
    }
    const r = await window.swarm.providers.removeCustomModel(id, target)
    if (!r.ok) setModelError(r.message)
  }

  const onApiStyleChange = async (style: ApiStyle): Promise<void> => {
    if (style === apiStyleDraft) return
    // Update local draft immediately so the radio reflects the click even
    // before the key is saved.
    setApiStyleDraft(style)
    setModelError(null)
    if (!hasKey) return // commit happens during save()
    const r = await window.swarm.providers.setApiStyle(id, style)
    if (!r.ok) setModelError(r.message)
  }

  const commitBaseUrl = async (): Promise<void> => {
    const trimmed = baseUrlDraft.trim()
    if (trimmed === serverBaseUrl) return
    setBaseUrlError(null)
    if (!hasKey) return // committed by save()
    const r = await window.swarm.providers.setBaseUrl(id, trimmed === '' ? null : trimmed)
    if (!r.ok) setBaseUrlError(r.message)
  }

  const commitContextWindow = async (): Promise<void> => {
    const trimmed = contextWindowDraft.trim()
    setContextWindowError(null)
    if (trimmed === '') {
      if (serverContextWindow == null) return
      if (!hasKey) return // committed by save()
      const r = await window.swarm.providers.setContextWindow(id, null)
      if (!r.ok) setContextWindowError(r.message)
      return
    }
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) {
      setContextWindowError('Must be a positive integer')
      return
    }
    if (n === serverContextWindow) return
    if (!hasKey) return // committed by save()
    const r = await window.swarm.providers.setContextWindow(id, n)
    if (!r.ok) setContextWindowError(r.message)
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    const r = await window.swarm.providers.test(id)
    setTesting(false)
    setTestResult(r)
  }

  // Ensure the current model always has a matching <option> even when it's
  // somehow not in the suggestions or customs list (e.g. legacy state).
  const orphanCurrent = !suggestions.includes(currentModel) && !customModelsDraft.includes(currentModel)

  return (
    <div className="space-y-3">
      <div className="font-medium text-sm">{LABEL[id]}</div>

      <div className="flex items-center gap-2">
        <label className="w-20 text-muted-foreground text-xs" htmlFor={`${id}-api-key`}>
          API key
        </label>
        <Input
          autoComplete="off"
          className="flex-1"
          disabled={saving}
          id={`${id}-api-key`}
          onChange={(e) => setDraftKey(e.target.value)}
          placeholder={hasKey ? '••••••••••••••••' : ''}
          spellCheck={false}
          type="password"
          value={draftKey}
        />
        <Button
          disabled={saving || draftKey.length === 0}
          onClick={() => {
            void save()
          }}
          size="sm"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="ml-22 flex items-center gap-3 text-xs">
        <span className={hasKey ? 'text-foreground' : 'text-muted-foreground'}>{hasKey ? 'Key set ✓' : 'Not set'}</span>
        {hasKey && (
          <Button
            onClick={() => {
              void clear()
            }}
            size="sm"
            variant="ghost"
          >
            Clear
          </Button>
        )}
        {saveError && <span className="text-red-500">{saveError}</span>}
      </div>

      {id === 'custom' && (
        <div className="flex items-center gap-2">
          <span className="w-20 text-muted-foreground text-xs">API style</span>
          <div className="flex gap-3 text-sm">
            {(['openai', 'anthropic'] as const).map((s) => (
              <label className="flex items-center gap-1.5" key={s}>
                <input
                  checked={apiStyleDraft === s}
                  name={`${id}-api-style`}
                  onChange={() => {
                    void onApiStyleChange(s)
                  }}
                  type="radio"
                  value={s}
                />
                {s === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible'}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="w-20 text-muted-foreground text-xs" htmlFor={`${id}-model`}>
          Model
        </label>
        <select
          className="flex-1 rounded border border-input bg-background px-2 py-1 text-sm"
          id={`${id}-model`}
          onChange={(e) => {
            void onSelectModel(e)
          }}
          value={currentModel}
        >
          <optgroup label="Built-in">
            {suggestions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </optgroup>
          {customModelsDraft.length > 0 && (
            <optgroup label="Custom">
              {customModelsDraft.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          )}
          {orphanCurrent && (
            <option key={currentModel} value={currentModel}>
              {currentModel}
            </option>
          )}
          <option value={ADD_CUSTOM_SENTINEL}>＋ Add custom model…</option>
        </select>
        {isCurrentModelCustom && (
          <Button
            onClick={() => {
              void removeCurrentCustom()
            }}
            size="sm"
            title={`Remove "${currentModel}" from custom models`}
            variant="ghost"
          >
            Remove
          </Button>
        )}
      </div>
      {addingCustom && (
        <div className="ml-22 flex items-center gap-2">
          <Input
            autoComplete="off"
            autoFocus
            className="flex-1"
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commitCustom()
              } else if (e.key === 'Escape') {
                setAddingCustom(false)
                setCustomDraft('')
                setCustomError(null)
              }
            }}
            placeholder="e.g. deepseek-chat"
            spellCheck={false}
            type="text"
            value={customDraft}
          />
          <Button
            disabled={customDraft.trim().length === 0}
            onClick={() => {
              void commitCustom()
            }}
            size="sm"
          >
            Add
          </Button>
          <Button
            onClick={() => {
              setAddingCustom(false)
              setCustomDraft('')
              setCustomError(null)
            }}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      )}
      {customError && <div className="ml-22 text-red-500 text-xs">{customError}</div>}
      {modelError && <div className="ml-22 text-red-500 text-xs">{modelError}</div>}

      <div className="flex items-center gap-2">
        <label className="w-20 text-muted-foreground text-xs" htmlFor={`${id}-base-url`}>
          Base URL
        </label>
        <Input
          autoComplete="off"
          className="flex-1"
          id={`${id}-base-url`}
          onBlur={() => {
            void commitBaseUrl()
          }}
          onChange={(e) => setBaseUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          placeholder={BASE_URL_PLACEHOLDER[id]}
          spellCheck={false}
          type="text"
          value={baseUrlDraft}
        />
      </div>
      <div className="ml-22 text-muted-foreground text-xs">
        Use the API root, not the full endpoint. Don&apos;t include <code>/chat/completions</code> or{' '}
        <code>/messages</code>; the client appends it.
        {id === 'custom' && ' Required for the custom provider.'}
      </div>
      {baseUrlError && <div className="ml-22 text-red-500 text-xs">{baseUrlError}</div>}

      {id === 'custom' && (
        <>
          <div className="flex items-center gap-2">
            <label className="w-20 text-muted-foreground text-xs" htmlFor={`${id}-context-window`}>
              Context window
            </label>
            <Input
              autoComplete="off"
              className="flex-1"
              id={`${id}-context-window`}
              inputMode="numeric"
              onBlur={() => {
                void commitContextWindow()
              }}
              onChange={(e) => setContextWindowDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              placeholder={String(DEFAULT_CONTEXT_WINDOW)}
              spellCheck={false}
              type="text"
              value={contextWindowDraft}
            />
          </div>
          <div className="ml-22 text-muted-foreground text-xs">
            Max tokens this model accepts. Leave blank to default to {DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens.
          </div>
          {contextWindowError && <div className="ml-22 text-red-500 text-xs">{contextWindowError}</div>}
        </>
      )}

      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <Button
            disabled={!hasKey || testing}
            onClick={() => {
              void runTest()
            }}
            size="sm"
            variant="outline"
          >
            {testing ? 'Testing…' : 'Test'}
          </Button>
          {testResult && <TestStatus result={testResult} />}
          {!hasKey && !testing && <span className="text-muted-foreground text-xs">— set a key first</span>}
        </div>
        {testResult?.url && (
          <div className="break-all text-muted-foreground text-xs">
            <span className="opacity-60">POST </span>
            <code>{testResult.url}</code>
          </div>
        )}
      </div>
    </div>
  )
}

function TestStatus({ result }: { result: ProvidersTestResult }): React.JSX.Element {
  if (result.ok) {
    return <span className="text-green-600 text-xs">✓ {result.latencyMs} ms</span>
  }
  const color =
    result.code === 'unauthorized'
      ? 'text-red-500'
      : result.code === 'rate_limited'
        ? 'text-amber-600'
        : 'text-muted-foreground'
  return <span className={`text-xs ${color} break-all`}>{result.message}</span>
}
