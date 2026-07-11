// apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx
// The ⌘K palette visual shell. Owns no palette state of its own: it wires the
// navigation/settings/theme/export/dispatch side-effects into a `Callbacks`
// object, hands that + the data `BuildInputs` to usePaletteState, then renders
// purely from the controller's output (query/scope/sections/flat/preview/keys).
//
// Layout: DialogContent = [PaletteInput] over a flex row of
// [PaletteResults (flex-1) | <aside> 296px preview], then a [PaletteFooter]
// status bar. Escape, ↑/↓/Enter and lone-prefix Backspace are handled by
// usePaletteState.onKeyDown, which is
// attached to DialogContent so it sees keys while the <input> is focused.
// The base-ui Dialog still dismisses on backdrop click / Esc via its own
// handler — our onKeyDown calls preventDefault on Escape and clears-or-closes
// inside the controller.
import { useMemo } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@swarm/ui'
import { useNavigate } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useTheme } from 'next-themes'

import { usePaletteData } from '../../hooks/use-palette-data'
import { useSubmitPrompt } from '../../hooks/use-runs'
import { useSettingsNav } from '../../hooks/use-settings-nav'
import { swarmApi } from '../../lib/api'
import type { Callbacks } from '../../lib/palette/build-items'
import type { PaletteItem } from '../../lib/palette/types'
import { useComposerDefaults } from '../../stores/composer-defaults'
import { useSearchDialog } from '../../stores/search-dialog'
import { PaletteInput } from './palette-input'
import { PaletteResults } from './palette-results'
import { PreviewSwitch } from './preview'
import { usePaletteState } from './use-palette-state'

const THEME_ORDER = ['system', 'light', 'dark'] as const

// The primary-action verb shown next to ↵, keyed off the selected row's kind so
// the footer reads like the design (查看进度 for a live task, 指派 for the
// dispatch hero, 打开 for a chat, 执行 for everything else).
function primaryActionLabel(selected: PaletteItem | null): string {
  switch (selected?.kind) {
    case 'taskRun':
      return '查看进度'
    case 'dispatch':
      return '指派给 Agent'
    case 'chat':
      return '打开对话'
    case 'service':
    case 'file':
      return '打开'
    default:
      return '执行'
  }
}

// Footer bar: shows the selected row's title (or 未选择 when nothing is
// selected) on the left, and a compact legend of the two keyboard affordances
// (↵ <action>, ⌘K 操作) on the right. Mounted inside DialogContent after the
// results+preview flex row so it always sits at the palette's bottom edge.
function PaletteFooter({ selected }: { selected: PaletteItem | null }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-border/60 border-t px-4 py-2 text-muted-foreground text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">{selected?.title ?? '未选择'}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px]">↵</kbd>
        <span>{primaryActionLabel(selected)}</span>
        <span className="opacity-50">·</span>
        <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
        <span>操作</span>
      </span>
    </div>
  )
}

export type PaletteDialogProps = {
  open: boolean
}

export function PaletteDialog({ open }: PaletteDialogProps): React.JSX.Element {
  const navigate = useNavigate()
  const { openSettings } = useSettingsNav()
  const { theme, setTheme } = useTheme()
  const setComposerAgent = useComposerDefaults((s) => s.setAgentType)
  const submitPrompt = useSubmitPrompt()
  const inputs = usePaletteData(open)
  const close = useSearchDialog((s) => s.close)

  // `submitPrompt` submits with whatever formation the user picked. The picked
  // value lives in usePaletteState (it needs to rebuild the dispatch item's
  // run()), so we don't reference it here; usePaletteState injects it into the
  // merged `cb` it passes to buildItems.
  const cb: Callbacks = useMemo(
    () => ({
      navigate: (to) => {
        close()
        void navigate({ to: to as never })
      },
      openSettings: (section) => {
        close()
        void openSettings(section as never)
      },
      cycleTheme: () => {
        // next-themes `theme` is a loose string; coerce into the union the
        // ORDER array is typed against before indexing.
        const current = (theme ?? 'system') as (typeof THEME_ORDER)[number]
        const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]
        setTheme(next)
      },
      exportMarkdown: (sessionId) => {
        if (sessionId) {
          void swarmApi.exportSessionMarkdown(sessionId)
          close()
        }
      },
      setComposerAgent: (id) => setComposerAgent(id),
      openArtifact: (ref) => {
        void window.swarm.openPath(ref)
        close()
      },
      submitPrompt: async (prompt, agentType) => {
        const r = await submitPrompt.mutateAsync({ prompt, options: { agentType }, forceNew: true })
        close()
        void navigate({ to: '/session/$sessionId', params: { sessionId: r.sessionId } })
        return r
      },
    }),
    [theme, setTheme, setComposerAgent, submitPrompt, openSettings, close, navigate]
  )

  const state = usePaletteState({ inputs, cb, open, close })

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close()
      }}
      open={open}
    >
      <DialogContent
        // `translate-y-0` cancels the base DialogContent's `-translate-y-1/2`
        // (it centers vertically); without it our `top-[96px]` anchor is pulled
        // up half the dialog height and the top rows clip off-screen.
        // Height is NOT fixed: only `max-h` caps it, so a short result list
        // yields a short dialog. `grid-rows-[auto_minmax(0,1fr)_auto]` lets the
        // middle (results/preview) row shrink so overflow scrolls inside it
        // instead of clipping the footer.
        // Responsive: below `md` (<768px) the palette fills the viewport width
        // and drops the preview aside; from `md` up it caps at 920×720 with the
        // 340px preview column.
        className="top-[96px] left-1/2 grid max-h-[calc(100vh-128px)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl border-border/60 bg-popover/82 p-0 text-popover-foreground shadow-2xl backdrop-blur-[40px] backdrop-saturate-150 supports-[backdrop-filter]:bg-popover/70 md:max-h-[min(720px,calc(100vh-128px))] md:w-[920px] md:max-w-[min(920px,calc(100vw-2rem))] dark:bg-popover/82"
        // The palette manages its own input focus + keyboard; hide the
        // default close X (Esc + backdrop still dismiss via base-ui).
        onKeyDown={state.onKeyDown}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">搜索对话、命令、任务、文件,或直接指派 Agent。</DialogDescription>

        <PaletteInput
          flatCount={state.flat.length}
          onQueryChange={state.setQuery}
          query={state.query}
          scope={state.scope}
        />

        <div className="flex min-h-0 min-w-0">
          <PaletteResults
            className="flex-1"
            flat={state.flat}
            onSetSelIndex={state.setSelIndex}
            query={state.query}
            sections={state.sections}
            selIndex={state.selIndex}
          />
          <aside className="cmdscroll hidden w-[340px] flex-none overflow-y-auto border-border/60 border-l bg-muted/30 md:block">
            <PreviewSwitch
              formations={state.formations}
              onPick={state.setPickedFormation}
              picked={state.pickedFormation}
              preview={state.preview}
            />
          </aside>
        </div>

        <PaletteFooter selected={state.selected} />
      </DialogContent>
    </Dialog>
  )
}
