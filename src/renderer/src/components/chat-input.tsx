import { useMemo } from 'react'
import type { ProviderId, ProvidersStateView } from '@shared/types/provider'
import type { ChatStatus } from 'ai'
import { Paperclip } from 'lucide-react'

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { useProviders } from '@/hooks/use-providers'

type Props = {
  onSubmit: (goal: string) => void | Promise<void>
  disabled?: boolean
  status?: ChatStatus
  onStop?: () => void
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

export function ChatInput({ onSubmit, disabled, status, onStop }: Props): React.JSX.Element {
  const { state } = useProviders()
  const options = useMemo(() => buildModelOptions(state), [state])
  const currentKey =
    state.active && state.providers[state.active] ? `${state.active}::${state.providers[state.active]!.model}` : ''

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    if (disabled) return
    const goal = message.text.trim()
    if (!goal) return
    await onSubmit(goal)
  }

  const onPickModel = async (key: string): Promise<void> => {
    const opt = options.find((o) => o.key === key)
    if (!opt) return
    if (state.active !== opt.providerId) await window.swarm.providers.setActive(opt.providerId)
    if (state.providers[opt.providerId]?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-4">
      <PromptInput className="mx-auto max-w-3xl" onSubmit={handleSubmit}>
        <PromptInputBody>
          <PromptInputTextarea autoFocus disabled={disabled} placeholder="Message the swarm…" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputButton disabled tooltip="Attachments — coming soon">
              <Paperclip className="size-4" />
            </PromptInputButton>
            {options.length > 0 && (
              <PromptInputSelect onValueChange={(v) => void onPickModel(String(v))} value={currentKey}>
                <PromptInputSelectTrigger>
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {options.map((o) => (
                    <PromptInputSelectItem key={o.key} value={o.key}>
                      {o.modelId}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          <PromptInputSubmit disabled={disabled} onStop={onStop} status={status} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
