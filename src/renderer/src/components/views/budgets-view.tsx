import { useEffect, useState } from 'react'
import { type BudgetConfig, defaultBudgetConfig } from '@shared/types/budgets'
import type { ResourceBudget } from '@shared/types/task'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBudgets } from '@/hooks/use-budgets'
import { SettingsHeader } from './settings-primitives'

// Fields are edited in friendly units (seconds, USD) and converted to the stored
// units (wallMs, usdCents) at the IPC boundary.
const FIELDS: {
  key: keyof ResourceBudget
  label: string
  toDisplay: (v: number) => number
  toStored: (v: number) => number
}[] = [
  { key: 'tokens', label: 'Max tokens', toDisplay: (v) => v, toStored: (v) => Math.round(v) },
  { key: 'calls', label: 'Max tool calls', toDisplay: (v) => v, toStored: (v) => Math.round(v) },
  {
    key: 'wallMs',
    label: 'Max wall time (seconds)',
    toDisplay: (v) => v / 1000,
    toStored: (v) => Math.round(v * 1000),
  },
  { key: 'usdCents', label: 'Max cost (USD)', toDisplay: (v) => v / 100, toStored: (v) => Math.round(v * 100) },
]

const sameConfig = (a: BudgetConfig, b: BudgetConfig): boolean =>
  (['main', 'sub'] as const).every((tier) =>
    (Object.keys(a[tier]) as (keyof ResourceBudget)[]).every((k) => a[tier][k] === b[tier][k])
  )

export function BudgetsView(): React.JSX.Element {
  const config = useBudgets()
  const [draft, setDraft] = useState<BudgetConfig>(config)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Re-seed the draft when the persisted config changes (initial load / other window).
  useEffect(() => {
    setDraft(config)
  }, [config])

  const setField = (tier: 'main' | 'sub', key: keyof ResourceBudget, stored: number): void => {
    setDraft((d) => ({ ...d, [tier]: { ...d[tier], [key]: stored } }))
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await window.swarm.budgets.set(draft)
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  const dirty = !sameConfig(draft, config)

  return (
    <div className="max-w-2xl space-y-5">
      <SettingsHeader
        description={
          <>
            Per-task spending caps. A task stops once it hits any limit. <strong>Main agent</strong> applies to tasks
            you start; <strong>Sub-agent</strong> applies to each agent spawned via <code>spawn_sub_agent</code>.
          </>
        }
        title="Budgets"
      />

      <BudgetSection budget={draft.main} onChange={(k, v) => setField('main', k, v)} title="Main agent" />

      <hr className="border-border" />

      <BudgetSection budget={draft.sub} onChange={(k, v) => setField('sub', k, v)} title="Sub-agent" />

      <hr className="border-border" />

      <div className="flex items-center gap-2">
        <Button disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </Button>
        <Button disabled={busy} onClick={() => setDraft(defaultBudgetConfig())} variant="outline">
          Reset to defaults
        </Button>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
    </div>
  )
}

function BudgetSection({
  title,
  budget,
  onChange,
}: {
  title: string
  budget: ResourceBudget
  onChange: (key: keyof ResourceBudget, stored: number) => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="font-medium text-sm">{title}</div>
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <div className="space-y-1" key={f.key}>
            <span className="text-muted-foreground text-xs">{f.label}</span>
            <Input
              min={0}
              onChange={(e) => onChange(f.key, f.toStored(Number(e.target.value) || 0))}
              type="number"
              value={f.toDisplay(budget[f.key])}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
