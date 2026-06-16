import { useMemo } from 'react'
import type { ModelThinkingLevel, ProviderId, ProvidersStateView } from '@shared/types/provider'
import type { Attachment } from '@shared/types/task'
import type { ChatStatus } from 'ai'
import { Paperclip, X } from 'lucide-react'

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
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { ContextRing } from '@/components/context-ring'
import { useProviders } from '@/hooks/use-providers'
import { imageAttachmentsFrom } from '@/lib/attachments'

type Props = {
  onSubmit: (goal: string, attachments?: Attachment[]) => void | Promise<void>
  disabled?: boolean
  status?: ChatStatus
  onStop?: () => void
  supportsImages?: boolean
  contextTokens?: number
  contextWindow?: number
  usdCents?: number
  placeholder?: string
}

type ModelOption = { providerId: ProviderId; modelId: string; key: string }

const PROVIDER_IDS: readonly ProviderId[] = ['anthropic', 'openai', 'custom'] as const
const MAX_FILES = 4
const MAX_FILE_SIZE = 5 * 1024 * 1024

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

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

// Thumbnail strip + attach button; must be a child of PromptInput (uses its attachments context).
function AttachBar({ supportsImages }: { supportsImages: boolean }): React.JSX.Element {
  const attachments = usePromptInputAttachments()
  return (
    <>
      {attachments.files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pb-1">
          {attachments.files.map((f) => (
            <div className="relative" key={f.id}>
              <img alt={f.filename ?? 'attachment'} className="size-14 rounded-md border object-cover" src={f.url} />
              <button
                aria-label="Remove attachment"
                className="absolute -top-1.5 -right-1.5 rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                onClick={() => attachments.remove(f.id)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <PromptInputButton
        disabled={!supportsImages}
        onClick={() => attachments.openFileDialog()}
        tooltip={supportsImages ? 'Attach images' : "This model can't read images"}
      >
        <Paperclip className="size-4" />
      </PromptInputButton>
    </>
  )
}

export function ChatInput({
  onSubmit,
  disabled,
  status,
  onStop,
  supportsImages = true,
  contextTokens,
  contextWindow,
  usdCents,
  placeholder,
}: Props): React.JSX.Element {
  const { state } = useProviders()
  const options = useMemo(() => buildModelOptions(state), [state])
  const currentKey =
    state.active && state.providers[state.active] ? `${state.active}::${state.providers[state.active]!.model}` : ''

  const handleSubmit = async (message: PromptInputMessage): Promise<void> => {
    if (disabled) return
    const goal = message.text.trim()
    if (!goal) return
    const attachments = imageAttachmentsFrom(message.files)
    await onSubmit(goal, attachments.length > 0 ? attachments : undefined)
  }

  const onPickModel = async (key: string): Promise<void> => {
    const opt = options.find((o) => o.key === key)
    if (!opt) return
    if (state.active !== opt.providerId) await window.swarm.providers.setActive(opt.providerId)
    if (state.providers[opt.providerId]?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

  const activeRow = state.active ? state.providers[state.active] : null
  const thinkingLevels = activeRow?.thinkingLevels ?? []
  // Only worth a picker when the model offers more than just 'off'.
  const showThinking = thinkingLevels.length > 1

  const onPickThinking = async (level: string): Promise<void> => {
    if (!state.active) return
    await window.swarm.providers.setThinkingLevel(state.active, level as ModelThinkingLevel)
  }

  return (
    <div className="shrink-0 px-4 pt-2 pb-4">
      <PromptInput
        accept="image/*"
        className="mx-auto max-w-3xl"
        maxFileSize={MAX_FILE_SIZE}
        maxFiles={MAX_FILES}
        onSubmit={handleSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea autoFocus disabled={disabled} placeholder={placeholder ?? 'Message the swarm…'} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <AttachBar supportsImages={supportsImages} />
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
            {showThinking && activeRow && (
              <PromptInputSelect onValueChange={(v) => void onPickThinking(String(v))} value={activeRow.thinkingLevel}>
                <PromptInputSelectTrigger>
                  <PromptInputSelectValue placeholder="Thinking" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {thinkingLevels.map((lvl) => (
                    <PromptInputSelectItem key={lvl} value={lvl}>
                      {THINKING_LABELS[lvl]}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          <div className="flex items-center gap-3">
            {contextTokens !== undefined && contextWindow !== undefined && (
              <ContextRing usdCents={usdCents} used={contextTokens} window={contextWindow} />
            )}
            <PromptInputSubmit disabled={disabled} onStop={onStop} status={status} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
