import { useEffect, useMemo, useRef, useState } from 'react'
import { type ProvidersStateView, providerViewById } from '@shared/types/provider'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProviders } from '@/hooks/use-providers'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
}

type ModelOption = { providerId: string; modelId: string; key: string }

function buildModelOptions(state: ProvidersStateView): ModelOption[] {
  const out: ModelOption[] = []
  for (const p of state.providers) {
    if (!p.hasKey) continue
    const seen = new Set<string>()
    for (const m of p.models) {
      if (seen.has(m)) continue
      seen.add(m)
      out.push({ providerId: p.id, modelId: m, key: `${p.id}::${m}` })
    }
  }
  return out
}

export function TaskInput({ onSubmit, disabled }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const { state } = useProviders()

  const options = useMemo(() => buildModelOptions(state), [state])
  const activeRow = providerViewById(state, state.active)
  const currentKey = state.active && activeRow ? `${state.active}::${activeRow.model}` : ''

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const goal = value.trim()
    if (!goal) return
    await onSubmit(goal)
    setValue('')
  }

  const onPickModel = async (e: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const opt = options.find((o) => o.key === e.target.value)
    if (!opt) return
    // Order matters: flip active first, then set its model. setModel requires
    // the row to exist; setActive does not, but doing it second would leave
    // a brief window where dispatch picks the old slot's model.
    if (state.active !== opt.providerId) {
      await window.swarm.providers.setActive(opt.providerId)
    }
    if (providerViewById(state, opt.providerId)?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

  return (
    <form className="flex shrink-0 items-center gap-2 border-b px-4 py-3" onSubmit={handleSubmit}>
      {options.length > 0 && (
        <select
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          onChange={(e) => {
            void onPickModel(e)
          }}
          title="Active model"
          value={currentKey}
        >
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.modelId}
            </option>
          ))}
        </select>
      )}
      <Input
        className="flex-1"
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Give the swarm a goal — e.g., 整理桌面文件 / Summarize today's slack threads"
        ref={ref}
        type="text"
        value={value}
      />
      <Button disabled={disabled || value.trim().length === 0} type="submit">
        Submit
      </Button>
    </form>
  )
}
