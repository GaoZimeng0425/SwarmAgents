import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProvidersStateView } from '@shared/types/provider'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useProviders } from '@/hooks/use-providers'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
}

type ModelOption = { providerId: ProviderId; modelId: string; key: string }

const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'custom'] as const

function buildModelOptions(state: ProvidersStateView): ModelOption[] {
  const out: ModelOption[] = []
  for (const id of PROVIDER_IDS) {
    const row = state.providers[id]
    if (!row?.hasKey) continue
    const seen = new Set<string>()
    for (const m of [row.model, ...(row.customModels ?? [])]) {
      if (seen.has(m)) continue
      seen.add(m)
      out.push({ providerId: id, modelId: m, key: `${id}::${m}` })
    }
  }
  return out
}

export function ChatInput({ onSubmit, disabled }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const { state } = useProviders()

  const options = useMemo(() => buildModelOptions(state), [state])
  const currentKey =
    state.active && state.providers[state.active] ? `${state.active}::${state.providers[state.active]!.model}` : ''

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    const goal = value.trim()
    if (!goal) return
    await onSubmit(goal)
    setValue('')
  }

  const onPickModel = async (e: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
    const opt = options.find((o) => o.key === e.target.value)
    if (!opt) return
    if (state.active !== opt.providerId) await window.swarm.providers.setActive(opt.providerId)
    if (state.providers[opt.providerId]?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

  return (
    <div className="shrink-0 border-t p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        {options.length > 0 && (
          <select
            className="h-9 rounded border border-input bg-background px-2 text-sm"
            onChange={(e) => void onPickModel(e)}
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
        <Textarea
          className="max-h-40 min-h-9 flex-1 resize-none"
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Message the swarm — Enter to send, Shift+Enter for newline"
          ref={ref}
          rows={1}
          value={value}
        />
        <Button disabled={disabled || value.trim().length === 0} onClick={() => void submit()}>
          Send
        </Button>
      </div>
    </div>
  )
}
