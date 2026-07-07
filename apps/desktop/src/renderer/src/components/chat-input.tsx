import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ExecutionMode, PermissionMode } from '@swarm/protocol'
import { type ModelThinkingLevel, type ProvidersStateView, providerViewById } from '@swarm/protocol'
import { SelectGroup, SelectLabel, SelectSeparator } from '@swarm/ui'
import { useRanger } from '@tanstack/react-ranger'
import { Check, Cpu, FileText, Folder, FolderOpen, ListChecks, Paperclip, Shield, Target, Users, X } from 'lucide-react'

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
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input'
import { AttachmentViewerSheet, type ViewerFile } from '@/components/attachment-viewer-sheet'
import { ContextRing } from '@/components/context-ring'
import { useProviders } from '@/hooks/use-providers'
import { imageAttachmentsFrom } from '@/lib/attachments'
import { ATTACHMENT_ACCEPT, DOCUMENT_ACCEPT, fileKind } from '@/lib/file-kind'
import { cn } from '@/lib/utils'
import { useRecentDirs } from '@/stores/recent-dirs'

type Props = {
  onSubmit: (goal: string, attachments?: Attachment[]) => void | Promise<void>
  disabled?: boolean
  // A turn is in flight: the submit button flips to a stop control that calls onStop.
  running?: boolean
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
  // Team selector: the company (CEO) default plus one entry per team head. The
  // chosen id flows into options.agentType so the run starts at that team's head.
  teamOptions?: { id: string; label: string }[]
  agentType?: string
  onAgentTypeChange?: (id: string) => void
  // Pinned items (pending permissions, plan progress, queued turns) rendered as
  // distinct rounded cards floating ABOVE the composer box, with their own
  // surface (bg-popover) so they layer above the translucent input field.
  // Undefined on the home screen, where there is nothing to pin.
  overlay?: React.ReactNode
  // Visual variant. 'default' is the session-view bottom bar (max-w-3xl, its own
  // outer padding, subtle input surface). 'hero' is the dashboard: a full-width,
  // elevated single panel (raised surface + real shadow) so the box reads as a
  // distinct, floating composer rather than a flat card the same color as the page.
  variant?: 'default' | 'hero'
}

type ModelOption = { providerId: string; providerName: string; modelId: string; key: string }

const MAX_FILES = 4
const MAX_FILE_SIZE = 25 * 1024 * 1024
// Minimum breathing room (px) kept between the footer's left and right control
// groups; the toolbar collapses labels to icons before this gap would close.
const GROUP_MIN_GAP = 16

const THINKING_LABELS: Record<ModelThinkingLevel, string> = {
  off: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

// Canonical low→high ordering, so the thinking slider's positions always run in
// intensity order regardless of how a provider lists its supported levels.
const THINKING_ORDER: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

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
  compact,
}: {
  cwd?: string
  onCwdChange?: (cwd: string | undefined) => void
  anchor: React.RefObject<HTMLElement | null>
  compact?: boolean
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
        {!compact && <span className="max-w-32 truncate">{cwd ? basename(cwd) : '工作目录'}</span>}
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
  running = false,
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
  teamOptions,
  agentType,
  onAgentTypeChange,
  overlay,
  variant = 'default',
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

  // The model's supported levels, ordered low→high for the slider track.
  const thinkingLevels = THINKING_ORDER.filter((l) => (activeRow?.thinkingLevels ?? []).includes(l))
  // Only worth a slider when the model offers more than just 'off'.
  const showThinking = thinkingLevels.length > 1
  // Slider position of the active level; clamp to 0 when it isn't in the list.
  const thinkingIndex = Math.max(0, thinkingLevels.indexOf(activeRow?.thinkingLevel ?? 'off'))
  const thinkingLast = Math.max(0, thinkingLevels.length - 1)
  // The track element TanStack Ranger measures for client-x → value mapping.
  const stepTrackRef = useRef<HTMLDivElement>(null)

  const onPickThinking = async (level: string): Promise<void> => {
    if (!state.active) return
    await window.swarm.providers.setThinkingLevel(state.active, level as ModelThinkingLevel)
  }

  // Commit a step index (clamped) to the active provider's thinking level.
  const commitThinkingIndex = (idx: number): void => {
    const clamped = Math.max(0, Math.min(thinkingLast, idx))
    const level = thinkingLevels[clamped]
    if (level && level !== activeRow?.thinkingLevel) void onPickThinking(level)
  }

  // TanStack Ranger drives the discrete "思考程度" stepper: a single handle over
  // the level indices [0..thinkingLast]. The ranger owns the drag wiring
  // (document mouse/touch listeners), the client-x → value interpolation, and
  // the step rounding that the old bespoke control hand-rolled. The level is
  // external state (synced over IPC), so the ranger is fully controlled by
  // `thinkingIndex` and every drag/keyboard change commits straight through
  // commitThinkingIndex — there is no local position state to drift out of sync.
  const thinkingRanger = useRanger<HTMLDivElement>({
    getRangerElement: () => stepTrackRef.current,
    values: [thinkingIndex],
    min: 0,
    max: thinkingLast,
    stepSize: 1,
    onChange: (instance) => commitThinkingIndex(Math.round(instance.sortedValues[0] ?? 0)),
    onDrag: (instance) => commitThinkingIndex(Math.round(instance.sortedValues[0] ?? 0)),
  })

  // Self-measuring footer: collapse the control labels to icons only when the
  // toolbar can't fit them. We compare the width the two control groups actually
  // need (measured live while their labels show) against the available row width
  // — no guessed breakpoint (Tailwind container queries don't fire here).
  // `naturalRef` remembers the labelled width so we know when there's room to
  // expand again while collapsed.
  const toolsRef = useRef<HTMLDivElement>(null)
  const leftGroupRef = useRef<HTMLDivElement>(null)
  const rightGroupRef = useRef<HTMLDivElement>(null)
  const naturalRef = useRef(0)
  const [compact, setCompact] = useState(false)
  const recomputeCompact = useCallback(() => {
    const row = toolsRef.current
    const left = leftGroupRef.current
    const right = rightGroupRef.current
    if (!row || !left || !right) return
    const available = row.clientWidth
    // Until the row has a real layout width (initial mount before paint, hidden
    // states, or a non-layout test env), every measurement reads zero and any
    // collapse decision would be bogus. Skip — the ResizeObserver recomputes once
    // the row is actually laid out with a real width.
    if (available === 0) return
    if (compact) {
      if (naturalRef.current && available >= naturalRef.current) setCompact(false)
    } else {
      // Labels are visible, so the groups report the width they truly need.
      naturalRef.current = left.offsetWidth + right.offsetWidth + GROUP_MIN_GAP
      if (available < naturalRef.current) setCompact(true)
    }
  }, [compact])
  useEffect(() => {
    const row = toolsRef.current
    if (!row) return
    const ro = new ResizeObserver(() => recomputeCompact())
    ro.observe(row)
    return () => ro.disconnect()
  }, [recomputeCompact])
  // Labels can change width without a row resize (model swap, cwd/team change),
  // so re-measure when their content changes too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the label-content inputs that change measured width
  useEffect(() => {
    recomputeCompact()
  }, [
    recomputeCompact,
    currentKey,
    agentType,
    permissionMode,
    cwd,
    teamOptions,
    showThinking,
    contextTokens === undefined,
  ])

  const hero = variant === 'hero'
  return (
    <div className={hero ? undefined : 'shrink-0 px-4 pt-2 pb-4'} ref={containerRef}>
      <div
        className={
          hero
            ? // The InputGroup IS the composer panel: a raised surface (bg-secondary,
              // distinct from the page-colored bg-card in dark mode), one hairline
              // border, and a real drop shadow so it floats — full-width, no session
              // padding or max-w-3xl. Matches the Hi-fi design's elevated input box.
              '[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-secondary [&_[data-slot=input-group]]:shadow-black/20 [&_[data-slot=input-group]]:shadow-lg'
            : 'mx-auto max-w-3xl [&_[data-slot=input-group]]:rounded-xl'
        }
        ref={composerRef}
      >
        {overlay}
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
            <div className="flex w-full items-center overflow-hidden" ref={toolsRef}>
              <div className="flex shrink-0 items-center gap-1" ref={leftGroupRef}>
                <ComposerAddMenu
                  anchor={composerRef}
                  executionMode={executionMode}
                  onExecutionModeChange={onExecutionModeChange}
                  onInsertPath={insertPathReference}
                  supportsImages={supportsImages}
                />
                <ComposerCwdMenu anchor={composerRef} compact={compact} cwd={cwd} onCwdChange={onCwdChange} />
                {teamOptions && teamOptions.length > 0 && (
                  <PromptInputSelect onValueChange={(v) => onAgentTypeChange?.(String(v))} value={agentType ?? 'ceo'}>
                    <PromptInputSelectTrigger>
                      <Users className="size-4 text-indigo-500 dark:text-indigo-400" />
                      {!compact && (
                        <PromptInputSelectValue>
                          {(v) =>
                            teamOptions.find((t) => t.id === ((v as string) ?? 'ceo'))?.label ?? teamOptions[0]?.label
                          }
                        </PromptInputSelectValue>
                      )}
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent>
                      {teamOptions.map((t) => (
                        <PromptInputSelectItem key={t.id} value={t.id}>
                          {t.label}
                        </PromptInputSelectItem>
                      ))}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                )}
                <PromptInputSelect
                  onValueChange={(v) => onPermissionModeChange?.(String(v) as PermissionMode)}
                  value={permissionMode}
                >
                  <PromptInputSelectTrigger>
                    <Shield
                      className={cn('size-4', permissionMode === 'full' ? 'text-amber-500' : 'text-muted-foreground')}
                    />
                    {!compact && (
                      <PromptInputSelectValue>
                        {(v) => PERMISSION_LABELS[(v as PermissionMode) ?? 'ask']}
                      </PromptInputSelectValue>
                    )}
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    <PromptInputSelectItem value="ask">{PERMISSION_LABELS.ask}</PromptInputSelectItem>
                    <PromptInputSelectItem value="full">{PERMISSION_LABELS.full}</PromptInputSelectItem>
                  </PromptInputSelectContent>
                </PromptInputSelect>
              </div>
              <div className="flex-1" />
              <div className="flex shrink-0 items-center gap-3" ref={rightGroupRef}>
                {contextTokens !== undefined && contextWindow !== undefined && (
                  <ContextRing
                    cacheRead={cacheReadTokens}
                    usdCents={usdCents}
                    used={contextTokens}
                    window={contextWindow}
                  />
                )}
                {options.length > 0 && (
                  // Single select merging the model picker and the thinking-level
                  // control. The value tracks the model only; the thinking level
                  // is a slider rendered below the model list, which calls
                  // onPickThinking directly without disturbing the model highlight.
                  <PromptInputSelect onValueChange={(v) => void onPickModel(String(v))} value={currentKey}>
                    <PromptInputSelectTrigger>
                      {compact ? (
                        <Cpu className="size-4 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <PromptInputSelectValue>
                          {() => {
                            const modelId = activeRow?.model ?? 'Model'
                            const lvl = activeRow?.thinkingLevel
                            const think = showThinking && lvl ? ` · ${THINKING_LABELS[lvl]}` : ''
                            return `${modelId}${think}`
                          }}
                        </PromptInputSelectValue>
                      )}
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
                          {/* Thinking level as a discrete slider. It lives inside the
                              popup but is not a select item, so it never moves the
                              model highlight or closes the dropdown. Pointer/keyboard
                              events are stopped so the slider drag and arrow keys don't
                              drive base-ui Select's item navigation. */}
                          <div
                            className="flex flex-col gap-2 px-2 py-1.5"
                            onKeyDown={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-between">
                              {/* Plain span, not SelectLabel: this label sits outside a
                                  SelectGroup (it labels a custom slider, not select
                                  items), and Base UI's GroupLabel requires a group
                                  context — using it here throws "SelectGroupContext is
                                  missing". The classes mirror SelectLabel's styling. */}
                              <span className="px-0 py-1 text-muted-foreground text-xs">思考程度</span>
                              <span className="font-medium text-muted-foreground text-xs">
                                {THINKING_LABELS[activeRow.thinkingLevel]}
                              </span>
                            </div>
                            {(() => {
                              // Discrete capsule stepper driven by TanStack Ranger. The
                              // single coordinate system is preserved on purpose: step
                              // centers, the filled segment, and the press target all
                              // derive from the same `i/last` percentages, so the rings,
                              // the line, and the snap point stay aligned. Ranger supplies
                              // the client-x → value mapping, step rounding, and the
                              // document-level drag listeners; pressing the track jumps to
                              // the nearest step and hands off to the ranger handle so a
                              // continued drag keeps updating the level live.
                              const last = thinkingLast
                              const current = thinkingIndex
                              return (
                                <div
                                  aria-label="思考程度"
                                  aria-valuemax={last}
                                  aria-valuemin={0}
                                  aria-valuenow={current}
                                  className="relative flex h-5 w-full cursor-pointer touch-none select-none items-center"
                                  onKeyDown={(e) => {
                                    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                                      e.preventDefault()
                                      commitThinkingIndex(current - 1)
                                    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                                      e.preventDefault()
                                      commitThinkingIndex(current + 1)
                                    }
                                  }}
                                  onPointerDown={(e) => {
                                    e.stopPropagation()
                                    commitThinkingIndex(Math.round(thinkingRanger.getValueForClientX(e.clientX)))
                                    thinkingRanger.handles()[0]?.onMouseDownHandler(e as unknown as MouseEvent)
                                  }}
                                  ref={stepTrackRef}
                                  role="slider"
                                  tabIndex={0}
                                >
                                  {/* Capsule line: spans the full stepper width. No
                                      horizontal padding here — the line, its filled
                                      segment, and the rings must all derive width from
                                      the same coordinate space (0%→100%). Any padding
                                      would shrink the fill's reference box and shift it
                                      off the first/last ring centers. */}
                                  <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted">
                                    {/* Filled segment, from the left edge to the current
                                        step's center — same percentage as the ring, so the
                                        fill always ends exactly under the active ring. */}
                                    <div
                                      className="h-full rounded-full bg-gradient-to-r from-primary to-primary/70 transition-[width] duration-150 ease-out"
                                      style={{ width: `${(current / last) * 100}%` }}
                                    />
                                  </div>
                                  {/* Step rings: one per level, centered on each step's
                                      percentage. Reached steps are primary-filled; the
                                      active step gets a larger ring with a white core;
                                      future steps are hollow. */}
                                  {thinkingLevels.map((lvl, i) => {
                                    const reached = i <= current
                                    const active = i === current
                                    return (
                                      <span
                                        className={cn(
                                          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-all duration-150',
                                          active
                                            ? 'size-3.5 border-primary bg-background ring-4 ring-primary/15'
                                            : reached
                                              ? 'size-2.5 border-primary bg-primary'
                                              : 'size-2.5 border-border bg-background'
                                        )}
                                        key={lvl}
                                        style={{ left: `${(i / last) * 100}%` }}
                                      />
                                    )
                                  })}
                                </div>
                              )
                            })()}
                            <div className="flex justify-between text-[10px] text-muted-foreground/70">
                              <span>{THINKING_LABELS[thinkingLevels[0]]}</span>
                              <span>{THINKING_LABELS[thinkingLevels[thinkingLevels.length - 1]]}</span>
                            </div>
                          </div>
                        </>
                      )}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                )}
                <PromptInputSubmit
                  disabled={running ? false : disabled}
                  onStop={onStop}
                  status={running ? 'streaming' : undefined}
                />
              </div>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
      <AttachmentViewerSheet file={viewerFile} onOpenChange={(open) => !open && setViewerFile(null)} />
    </div>
  )
}
