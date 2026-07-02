import { useEffect, useState } from 'react'
import type { WebSearchConfigView, WebSearchProviderId } from '@swarm/protocol'

import { Button } from '@swarm/ui'
import { Input } from '@swarm/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarm/ui'
import { useWebSearch } from '@/hooks/use-web-search'
import { Section, SettingsHeader } from './settings-primitives'

const PROVIDER_OPTIONS: { value: WebSearchProviderId; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Pick the first backend with a key (Tavily → Brave → SearXNG → DuckDuckGo).' },
  { value: 'tavily', label: 'Tavily', hint: 'LLM-optimized search. Needs a Tavily API key.' },
  { value: 'brave', label: 'Brave', hint: 'General web search. Needs a Brave Search API key.' },
  { value: 'searxng', label: 'SearXNG', hint: 'Self-hosted metasearch. Needs an instance URL.' },
  { value: 'duckduckgo', label: 'DuckDuckGo', hint: 'No key required. Scrapes HTML; fragile — best for local use.' },
]

export function WebSearchView(): React.JSX.Element {
  const state = useWebSearch()

  return (
    <div className="space-y-5">
      <SettingsHeader
        description={
          <>
            Choose the backend the <code>web_search</code> tool uses. API keys are encrypted at rest using the system
            Keychain. An empty key falls back to the matching environment variable.
          </>
        }
        title="Web Search"
      />

      <ProviderPicker state={state} />

      <hr className="border-border" />

      <KeyRow hasKey={state.hasTavilyKey} id="tavily" label="Tavily API key" placeholder="tvly-…" />

      <hr className="border-border" />

      <KeyRow hasKey={state.hasBraveKey} id="brave" label="Brave Search API key" placeholder="BSA…" />

      <hr className="border-border" />

      <SearxngUrlRow url={state.searxngUrl ?? ''} />
    </div>
  )
}

function ProviderPicker({ state }: { state: WebSearchConfigView }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const onChange = async (value: string): Promise<void> => {
    setError(null)
    const r = await window.swarm.webSearch.setProvider(value as WebSearchProviderId)
    if (!r.ok) setError(r.message)
  }
  const hint = PROVIDER_OPTIONS.find((o) => o.value === state.provider)?.hint
  return (
    <Section label="Provider">
      <Select
        onValueChange={(v) => {
          if (v) void onChange(v)
        }}
        value={state.provider}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </Section>
  )
}

function KeyRow({
  id,
  label,
  hasKey,
  placeholder,
}: {
  id: 'tavily' | 'brave'
  label: string
  hasKey: boolean
  placeholder: string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (draft.length === 0) return
    setBusy(true)
    setError(null)
    const r = await window.swarm.webSearch.setKey(id, draft)
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    setDraft('')
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.swarm.webSearch.clearKey(id)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{label}</span>
        <span className="text-muted-foreground text-xs">{hasKey ? '✓ configured' : 'not set'}</span>
      </div>
      <div className="flex gap-2">
        <Input
          onChange={(e) => setDraft(e.target.value)}
          placeholder={hasKey ? '•••••••• (saved) — type to replace' : placeholder}
          type="password"
          value={draft}
        />
        <Button disabled={busy || draft.length === 0} onClick={() => void save()}>
          Save
        </Button>
        {hasKey && (
          <Button disabled={busy} onClick={() => void clear()} variant="outline">
            Clear
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}

function SearxngUrlRow({ url }: { url: string }): React.JSX.Element {
  const [draft, setDraft] = useState(url)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Keep the draft in sync when the server value changes (e.g. another window).
  useEffect(() => {
    setDraft(url)
  }, [url])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.swarm.webSearch.setSearxngUrl(draft.trim() || null)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  return (
    <div className="space-y-2">
      <span className="font-medium text-sm">SearXNG instance URL</span>
      <div className="flex gap-2">
        <Input onChange={(e) => setDraft(e.target.value)} placeholder="https://searxng.example.com" value={draft} />
        <Button disabled={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}
