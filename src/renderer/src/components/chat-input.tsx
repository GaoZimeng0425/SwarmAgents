import { useMemo, useRef, useState } from 'react'
import { type ModelThinkingLevel, type ProvidersStateView, providerViewById } from '@shared/types/provider'
import type { Attachment, ExecutionMode, PermissionMode } from '@shared/types/task'
import { FileText, Folder, FolderOpen, ListChecks, Paperclip, Shield, Target, X } from 'lucide-react'

import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
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
  // Composer execution controls, owned by the parent so they persist across the
  // session's turns (each turn is a fresh task that must inherit the same cwd/mode).
  cwd?: string
  onCwdChange?: (cwd: string | undefined) => void
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  executionMode?: ExecutionMode
  onExecutionModeChange?: (mode: ExecutionMode) => void
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

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: '询问权限',
  full: '完全操作权限',
}

const EXECUTION_LABELS: Record<ExecutionMode, string> = {
  goal: '目标模式',
  plan: '计划模式',
}

// Last path segment, for a compact working-directory chip label.
function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
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

// Thumbnail strip + the "＋" menu (attach files, reference a file/folder by path).
// Must be a child of PromptInput (uses its attachments context).
function AttachArea({
  supportsImages,
  onOpenFile,
  onInsertPath,
}: {
  supportsImages: boolean
  onOpenFile: (file: ViewerFile) => void
  onInsertPath: (path: string) => void
}): React.JSX.Element {
  const attachments = usePromptInputAttachments()

  const pick = async (kind: 'file' | 'directory'): Promise<void> => {
    const path = kind === 'directory' ? await window.swarm.pickDirectory() : await window.swarm.pickFile()
    if (path) onInsertPath(path)
  }

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
      <PromptInputActionMenu>
        <PromptInputActionMenuTrigger
          tooltip={supportsImages ? '附加文件或引用路径' : '附加文档或引用路径(图片需视觉模型)'}
        />
        <PromptInputActionMenuContent>
          <PromptInputActionMenuItem onClick={() => attachments.openFileDialog()}>
            <Paperclip className="size-4" />
            {supportsImages ? '上传图片 / 文件' : '上传文件'}
          </PromptInputActionMenuItem>
          <PromptInputActionMenuItem onClick={() => void pick('file')}>
            <FileText className="size-4" />
            选择文件
          </PromptInputActionMenuItem>
          <PromptInputActionMenuItem onClick={() => void pick('directory')}>
            <FolderOpen className="size-4" />
            选择文件夹
          </PromptInputActionMenuItem>
        </PromptInputActionMenuContent>
      </PromptInputActionMenu>
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
  cwd,
  onCwdChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  executionMode = 'goal',
  onExecutionModeChange,
}: Props): React.JSX.Element {
  const { state } = useProviders()
  const [viewerFile, setViewerFile] = useState<ViewerFile | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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

  // The composer textarea is uncontrolled (read via FormData on submit), so we
  // append the picked path through the native value setter and fire an input
  // event — that keeps field-sizing and any listeners in sync.
  const insertPathReference = (path: string): void => {
    const ta = containerRef.current?.querySelector('textarea[name="message"]') as HTMLTextAreaElement | null
    if (!ta) return
    const needsSpace = ta.value.length > 0 && !/\s$/.test(ta.value)
    const next = `${ta.value}${needsSpace ? ' ' : ''}@${path} `
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(ta, next)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
  }

  const onPickCwd = async (): Promise<void> => {
    const path = await window.swarm.pickDirectory()
    if (path) onCwdChange?.(path)
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
    <div className="shrink-0 px-4 pt-2 pb-4" ref={containerRef}>
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
            <AttachArea onInsertPath={insertPathReference} onOpenFile={setViewerFile} supportsImages={supportsImages} />
            <div className="flex items-center">
              <PromptInputButton onClick={() => void onPickCwd()} tooltip={cwd ?? '选择工作目录(默认为用户主目录)'}>
                <Folder className="size-4" />
                <span className="max-w-32 truncate">{cwd ? basename(cwd) : '工作目录'}</span>
              </PromptInputButton>
              {cwd && (
                <button
                  aria-label="Clear working directory"
                  className="ml-0.5 rounded-full p-1 text-muted-foreground hover:text-foreground"
                  onClick={() => onCwdChange?.(undefined)}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <PromptInputSelect
              onValueChange={(v) => onPermissionModeChange?.(String(v) as PermissionMode)}
              value={permissionMode}
            >
              <PromptInputSelectTrigger>
                <Shield className="size-4" />
                <PromptInputSelectValue>
                  {(v) => PERMISSION_LABELS[(v as PermissionMode) ?? 'ask']}
                </PromptInputSelectValue>
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                <PromptInputSelectItem value="ask">{PERMISSION_LABELS.ask}</PromptInputSelectItem>
                <PromptInputSelectItem value="full">{PERMISSION_LABELS.full}</PromptInputSelectItem>
              </PromptInputSelectContent>
            </PromptInputSelect>
            <PromptInputSelect
              onValueChange={(v) => onExecutionModeChange?.(String(v) as ExecutionMode)}
              value={executionMode}
            >
              <PromptInputSelectTrigger>
                {executionMode === 'plan' ? <ListChecks className="size-4" /> : <Target className="size-4" />}
                <PromptInputSelectValue>
                  {(v) => EXECUTION_LABELS[(v as ExecutionMode) ?? 'goal']}
                </PromptInputSelectValue>
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                <PromptInputSelectItem value="goal">{EXECUTION_LABELS.goal}</PromptInputSelectItem>
                <PromptInputSelectItem value="plan">{EXECUTION_LABELS.plan}</PromptInputSelectItem>
              </PromptInputSelectContent>
            </PromptInputSelect>
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
