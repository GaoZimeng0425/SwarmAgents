import { useMemo, useState } from 'react'
import { type ModelThinkingLevel, type ProvidersStateView, providerViewById } from '@shared/types/provider'
import type { Attachment } from '@shared/types/task'
import { FileText, Paperclip, X } from 'lucide-react'

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
import type { ChatStatus } from '@/components/ai-elements/types'
import { AttachmentViewerSheet, type ViewerFile } from '@/components/attachment-viewer-sheet'
import { ContextRing } from '@/components/context-ring'
import { useProviders } from '@/hooks/use-providers'
import { imageAttachmentsFrom } from '@/lib/attachments'
import { ATTACHMENT_ACCEPT, DOCUMENT_ACCEPT, fileKind } from '@/lib/file-kind'

type Props = {
  onSubmit: (goal: string, attachments?: Attachment[]) => void | Promise<void>
  disabled?: boolean
  status?: ChatStatus
  onStop?: () => void
  supportsImages?: boolean
  contextTokens?: number
  contextWindow?: number
  usdCents?: number
  cacheReadTokens?: number
  placeholder?: string
}

type ModelOption = { providerId: string; providerName: string; modelId: string; key: string }

const MAX_FILES = 4
const MAX_FILE_SIZE = 25 * 1024 * 1024

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
  for (const p of state.providers) {
    if (!p.hasKey) continue
    const seen = new Set<string>()
    for (const m of p.models) {
      if (seen.has(m)) continue
      seen.add(m)
      out.push({ providerId: p.id, providerName: p.name, modelId: m, key: `${p.id}::${m}` })
    }
  }
  return out
}

// Thumbnail strip + attach button; must be a child of PromptInput (uses its attachments context).
function AttachBar({
  supportsImages,
  onOpenFile,
}: {
  supportsImages: boolean
  onOpenFile: (file: ViewerFile) => void
}): React.JSX.Element {
  const attachments = usePromptInputAttachments()
  return (
    <>
      {attachments.files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pb-1">
          {attachments.files.map((f) => {
            const kind = fileKind(f.mediaType)
            return (
              <div className="relative" key={f.id}>
                {kind === 'image' ? (
                  <img
                    alt={f.filename ?? 'attachment'}
                    className="size-14 rounded-md border object-cover"
                    src={f.url}
                  />
                ) : (
                  <button
                    className="flex h-14 max-w-40 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-left hover:bg-muted"
                    onClick={() => onOpenFile({ url: f.url, mediaType: f.mediaType, filename: f.filename })}
                    title={f.filename ?? 'attachment'}
                    type="button"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs">{f.filename ?? kind.toUpperCase()}</span>
                  </button>
                )}
                <button
                  aria-label="Remove attachment"
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                  onClick={() => attachments.remove(f.id)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <PromptInputButton
        onClick={() => attachments.openFileDialog()}
        tooltip={supportsImages ? 'Attach files' : 'Attach documents (images need a vision model)'}
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
  cacheReadTokens,
  placeholder,
}: Props): React.JSX.Element {
  const { state } = useProviders()
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const options = useMemo(() => buildModelOptions(state), [state])
  const activeRow = providerViewById(state, state.active)
  const currentKey = state.active && activeRow ? `${state.active}::${activeRow.model}` : ''

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
    if (providerViewById(state, opt.providerId)?.model !== opt.modelId) {
      await window.swarm.providers.setModel(opt.providerId, opt.modelId)
    }
  }

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
        accept={supportsImages ? ATTACHMENT_ACCEPT : DOCUMENT_ACCEPT}
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
            <AttachBar onOpenFile={setViewerFile} supportsImages={supportsImages} />
            {options.length > 0 && (
              <PromptInputSelect onValueChange={(v) => void onPickModel(String(v))} value={currentKey}>
                <PromptInputSelectTrigger>
                  <PromptInputSelectValue placeholder="Model">
                    {(key) => {
                      const o = options.find((opt) => opt.key === key)
                      return o ? `${o.providerName} · ${o.modelId}` : 'Model'
                    }}
                  </PromptInputSelectValue>
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {options.map((o) => (
                    <PromptInputSelectItem key={o.key} value={o.key}>
                      {o.providerName} · {o.modelId}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
            {showThinking && activeRow && (
              <PromptInputSelect onValueChange={(v) => void onPickThinking(String(v))} value={activeRow.thinkingLevel}>
                <PromptInputSelectTrigger>
                  <PromptInputSelectValue placeholder="Thinking">
                    {(lvl) => (lvl ? THINKING_LABELS[lvl as ModelThinkingLevel] : 'Thinking')}
                  </PromptInputSelectValue>
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
              <ContextRing
                cacheRead={cacheReadTokens}
                usdCents={usdCents}
                used={contextTokens}
                window={contextWindow}
              />
            )}
            <PromptInputSubmit disabled={disabled} onStop={onStop} status={status} />
          </div>
        </PromptInputFooter>
      </PromptInput>
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </div>
  )
}
