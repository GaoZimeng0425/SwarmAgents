import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderId, ProvidersStateView } from '@shared/types/provider'
import { ArrowUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { useProviders } from '@/hooks/use-providers'
import { cn } from '@/lib/utils'

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
    <div className="shrink-0 px-4 pt-2 pb-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="group relative flex items-end gap-2 rounded-[26px] border bg-card/80 backdrop-blur-md px-4 py-3 shadow-lg transition-all duration-300 focus-within:border-primary/50 focus-within:shadow-primary/5 focus-within:ring-4 focus-within:ring-primary/5">
          <Textarea
            className="max-h-52 min-h-[28px] flex-1 resize-none border-0 bg-transparent p-0 text-[15px] shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/60"
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="Message the swarm…"
            ref={ref}
            rows={1}
            value={value}
          />
          <Button
            aria-label="Send"
            className={cn(
              "size-9 shrink-0 rounded-full transition-all duration-300",
              value.trim().length > 0 ? "scale-100 opacity-100" : "scale-90 opacity-40 grayscale"
            )}
            disabled={disabled || value.trim().length === 0}
            onClick={() => void submit()}
            size="icon"
          >
            <ArrowUp className="size-5 stroke-[2.5px]" />
          </Button>
        </div>
        {options.length > 0 && (
          <div className="flex justify-between items-center px-4">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 font-medium uppercase tracking-tight">
              <div className="size-1.5 rounded-full bg-emerald-500/80 animate-pulse" />
              Swarm Active
            </div>
            <NativeSelect 
              className="h-7 bg-transparent border-0 text-[12px] font-medium text-muted-foreground/80 hover:text-foreground transition-colors"
              onChange={(e) => void onPickModel(e)} 
              size="sm" 
              title="Active model" 
              value={currentKey}
            >
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
