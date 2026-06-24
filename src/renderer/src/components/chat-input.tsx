import { useMemo, useRef, useState } from 'react'
import { type ModelThinkingLevel, type ProvidersStateView, providerViewById } from '@shared/types/provider'
import type { Attachment, ExecutionMode, PermissionMode } from '@shared/types/task'
import { Check, FileText, Folder, FolderOpen, ListChecks, Paperclip, Shield, Target, X } from 'lucide-react'

import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuSeparator,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
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
import { SelectGroup, SelectLabel, SelectSeparator } from '@/components/ui/select'
import { useProviders } from '@/hooks/use-providers'
import { imageAttachmentsFrom } from '@/lib/attachments'
import { ATTACHMENT_ACCEPT, DOCUMENT_ACCEPT, fileKind } from '@/lib/file-kind'
import { useRecentDirs } from '@/stores/recent-dirs'

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

// Attachment thumbnail strip, rendered in the composer header above the textarea.
// Only mounts the header bar when there is at least one attachment, so an empty
// composer shows no stray top padding. Must be a child of PromptInput (attachments context).
function AttachmentThumbnails({ onOpenFile }: { onOpenFile: (file: ViewerFile) => void }): React.JSX.Element | null {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null

  return (
    <PromptInputHeader>
      <div className="flex flex-wrap gap-2 px-1 pb-1">
        {attachments.files.map((f) => {
          const kind = fileKind(f.mediaType)
          return (
            <div className="relative" key={f.id}>
              {kind === 'image' ? (
                <img alt={f.filename ?? 'attachment'} className="size-14 rounded-md border object-cover" src={f.url} />
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
    </PromptInputHeader>
  )
}

// The "＋" menu in the footer: attach files / reference a path, plus the
// goal/plan execution-mode toggle. Anchored to the composer box (not the trigger)
// and opened with side="top", so the whole panel floats entirely above the input
// box instead of overlapping it. Must be a child of PromptInput (attachments context).
function ComposerAddMenu({
  supportsImages,
  onInsertPath,
  executionMode,
  onExecutionModeChange,
  anchor,
}: {
  supportsImages: boolean
  onInsertPath: (path: string) => void
  executionMode: ExecutionMode
  onExecutionModeChange?: (mode: ExecutionMode) => void
  anchor: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const attachments = usePromptInputAttachments()

  const pick = async (kind: 'file' | 'directory'): Promise<void> => {
    const path = kind === 'directory' ? await window.swarm.pickDirectory() : await window.swarm.pickFile()
    if (path) onInsertPath(path)
  }

  return (
    <PromptInputActionMenu>
      <PromptInputActionMenuTrigger tooltip="附加文件、设置目标或计划模式" />
      <PromptInputActionMenuContent align="start" anchor={anchor} className="min-w-56" side="top" sideOffset={8}>
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
        <PromptInputActionMenuSeparator />
        <PromptInputActionMenuItem onClick={() => onExecutionModeChange?.('goal')}>
          <Target className="size-4" />
          <span className="flex flex-col">
            <span>{EXECUTION_LABELS.goal}</span>
            <span className="text-muted-foreground text-xs">持续努力实现设定的目标</span>
          </span>
          {executionMode === 'goal' && <Check className="ml-auto size-4" />}
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onClick={() => onExecutionModeChange?.('plan')}>
          <ListChecks className="size-4" />
          <span className="flex flex-col">
            <span>{EXECUTION_LABELS.plan}</span>
            <span className="text-muted-foreground text-xs">先制定计划, 确认后再执行</span>
          </span>
          {executionMode === 'plan' && <Check className="ml-auto size-4" />}
        </PromptInputActionMenuItem>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  )
}

// Working-directory picker shaped like the "＋" menu: opens a dropdown listing
// previously-picked directories, with "选择目录…" at the bottom to browse for a
// new one (the only entry that hits the native dialog).
function ComposerCwdMenu({
  cwd,
  onCwdChange,
  anchor,
}: {
  cwd?: string
  onCwdChange?: (cwd: string | undefined) => void
  anchor: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const recent = useRecentDirs((s) => s.dirs)
  const addRecent = useRecentDirs((s) => s.add)

  const choose = (path: string): void => {
    addRecent(path)
    onCwdChange?.(path)
  }

  const pick = async (): Promise<void> => {
    const path = await window.swarm.pickDirectory()
    if (path) choose(path)
  }

  return (
    <PromptInputActionMenu>
      <PromptInputActionMenuTrigger tooltip={cwd ?? '选择工作目录(默认为用户主目录)'}>
        <Folder className="size-4" />
        <span className="max-w-32 truncate">{cwd ? basename(cwd) : '工作目录'}</span>
      </PromptInputActionMenuTrigger>
      <PromptInputActionMenuContent align="start" anchor={anchor} className="min-w-56" side="top" sideOffset={8}>
        {recent.map((dir) => (
          <PromptInputActionMenuItem key={dir} onClick={() => choose(dir)}>
            <Folder className="size-4" />
            <span className="truncate" title={dir}>
              {basename(dir)}
            </span>
            {cwd === dir && <Check className="ml-auto size-4" />}
          </PromptInputActionMenuItem>
        ))}
        {recent.length > 0 && <PromptInputActionMenuSeparator />}
        <PromptInputActionMenuItem onClick={() => void pick()}>
          <FolderOpen className="size-4" />
          选择目录…
        </PromptInputActionMenuItem>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
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
  // Anchors the "＋" menu to the composer box so it opens fully above the input.
  const composerRef = useRef<HTMLDivElement>(null)
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
      <div className="mx-auto max-w-3xl" ref={composerRef}>
        <PromptInput
          accept={supportsImages ? ATTACHMENT_ACCEPT : DOCUMENT_ACCEPT}
          maxFileSize={MAX_FILE_SIZE}
          maxFiles={MAX_FILES}
          onSubmit={handleSubmit}
        >
          <AttachmentThumbnails onOpenFile={setViewerFile} />
          <PromptInputBody>
            <PromptInputTextarea autoFocus disabled={disabled} placeholder={placeholder ?? 'Message the swarm…'} />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools className="w-full">
              <div className="flex items-center gap-1">
                <ComposerAddMenu
                  anchor={composerRef}
                  executionMode={executionMode}
                  onExecutionModeChange={onExecutionModeChange}
                  onInsertPath={insertPathReference}
                  supportsImages={supportsImages}
                />
                <ComposerCwdMenu anchor={composerRef} cwd={cwd} onCwdChange={onCwdChange} />
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
              </div>
              <div className="ml-auto flex items-center gap-1">
                {contextTokens !== undefined && contextWindow !== undefined && (
                  <ContextRing
                    cacheRead={cacheReadTokens}
                    usdCents={usdCents}
                    used={contextTokens}
                    window={contextWindow}
                  />
                )}
              </div>
            </PromptInputTools>
            <div className="flex items-center gap-3">
              {options.length > 0 && (
                // Single select merging the model picker and the thinking-level
                // picker. The value tracks the model only, so base-ui highlights
                // the model row; picking a thinking level calls onPickThinking
                // and re-renders without moving the highlight.
                <PromptInputSelect
                  onValueChange={(v) => {
                    const value = String(v)
                    if (value.startsWith('thinking::')) {
                      void onPickThinking(value.slice('thinking::'.length))
                      return
                    }
                    void onPickModel(value)
                  }}
                  value={currentKey}
                >
                  <PromptInputSelectTrigger>
                    <PromptInputSelectValue>
                      {() => {
                        const modelId = activeRow?.model ?? 'Model'
                        const lvl = activeRow?.thinkingLevel
                        const think = showThinking && lvl ? ` · ${THINKING_LABELS[lvl]}` : ''
                        return `${modelId}${think}`
                      }}
                    </PromptInputSelectValue>
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent className="w-auto min-w-(--anchor-width) max-w-[min(28rem,90vw)]">
                    <SelectGroup>
                      <SelectLabel>模型</SelectLabel>
                      {options.map((o) => (
                        <PromptInputSelectItem key={o.key} value={o.key}>
                          {o.providerName} · {o.modelId}
                        </PromptInputSelectItem>
                      ))}
                    </SelectGroup>
                    {showThinking && activeRow && (
                      <>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>思考程度</SelectLabel>
                          {thinkingLevels.map((lvl) => (
                            <PromptInputSelectItem key={lvl} value={`thinking::${lvl}`}>
                              {THINKING_LABELS[lvl]}
                            </PromptInputSelectItem>
                          ))}
                        </SelectGroup>
                      </>
                    )}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              )}
              <PromptInputSubmit disabled={disabled} onStop={onStop} status={status} />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </div>
  )
}
