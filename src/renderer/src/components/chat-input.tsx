import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProvidersStateView } from '@shared/types/provider'
import { ArrowUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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
    <div className="shrink-0 px-3 pt-1 pb-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        <div className="flex items-end gap-2 rounded-2xl border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring/60">
          <Textarea
            className="max-h-40 min-h-6 flex-1 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="Message the swarm — Enter to send, Shift+Enter for newline"
            ref={ref}
            rows={1}
            value={value}
          />
          <Button
            aria-label="Send"
            className="size-8 shrink-0 rounded-full"
            disabled={disabled || value.trim().length === 0}
            onClick={() => void submit()}
            size="icon"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
        {options.length > 0 && (
          <div className="flex justify-end px-1">
            <NativeSelect onChange={(e) => void onPickModel(e)} size="sm" title="Active model" value={currentKey}>
              {options.map((o) => (
                <NativeSelectOption key={o.key} value={o.key}>
                  {o.modelId}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
    </div>
  )
}
