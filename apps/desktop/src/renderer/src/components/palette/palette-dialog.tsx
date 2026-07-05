// apps/desktop/src/renderer/src/components/palette/palette-dialog.tsx
// The ⌘K palette visual shell. Owns no palette state of its own: it wires the
// navigation/settings/theme/export/dispatch side-effects into a `Callbacks`
// object, hands that + the data `BuildInputs` to usePaletteState, then renders
// purely from the controller's output (query/scope/sections/flat/preview/keys).
//
// Layout: DialogContent = [PaletteInput] over a flex row of
// [PaletteResults (flex-1) | <aside> 296px preview]. Escape, ↑/↓/Enter and
// lone-prefix Backspace are handled by usePaletteState.onKeyDown, which is
// attached to DialogContent so it sees keys while the <input> is focused.
// The base-ui Dialog still dismisses on backdrop click / Esc via its own
// handler — our onKeyDown calls preventDefault on Escape and clears-or-closes
// inside the controller.
import { useMemo } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from '@swarm/ui'
import { useNavigate } from '@tanstack/react-router'
import { useTheme } from 'next-themes'

import { usePaletteData } from '../../hooks/use-palette-data'
import { useSubmitGoal } from '../../hooks/use-runs'
import { swarmApi } from '../../lib/api'
import type { Callbacks } from '../../lib/palette/build-items'
import type { PreviewData } from '../../lib/palette/types'
import { useComposerDefaults } from '../../stores/composer-defaults'
import { useSearchDialog } from '../../stores/search-dialog'
import { useSettingsDialog } from '../../stores/settings-dialog'
import { PaletteInput } from './palette-input'
import { PaletteResults } from './palette-results'
import { usePaletteState } from './use-palette-state'

const THEME_ORDER = ['system', 'light', 'dark'] as const

export type PaletteDialogProps = {
  open: boolean
}

export function PaletteDialog({ open }: PaletteDialogProps): React.JSX.Element {
  const navigate = useNavigate()
  const openSettings = useSettingsDialog((s) => s.openSettings)
  const { theme, setTheme } = useTheme()
  const setComposerAgent = useComposerDefaults((s) => s.setAgentType)
  const submitGoal = useSubmitGoal()
  const inputs = usePaletteData()
  const close = useSearchDialog((s) => s.close)

  // `submitGoal` here hardcodes the formation to 'ceo'. Task 8 adds the
  // `pickedFormation` picker state and threads the user's choice through.
  const cb: Callbacks = useMemo(
    () => ({
      navigate: (to) => {
        close()
        void navigate({ to: to as never })
      },
      openSettings: (section) => {
        close()
        openSettings(section as never)
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
      submitGoal: async (goal, agentType) => {
        const r = await submitGoal.mutateAsync({ goal, options: { agentType }, forceNew: true })
        close()
        void navigate({ to: '/session/$sessionId', params: { sessionId: r.sessionId } })
        return r
      },
    }),
    [theme, setTheme, setComposerAgent, submitGoal, openSettings, close, navigate]
  )

  const state = usePaletteState({ inputs, cb, open, close })

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close()
      }}
      open={open}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/30 backdrop-blur-[2px]" />
        <DialogContent
          className="top-[96px] left-1/2 grid h-[660px] max-h-[660px] w-[760px] max-w-[760px] -translate-x-1/2 gap-0 overflow-hidden rounded-2xl border-border/60 bg-popover/82 p-0 text-popover-foreground shadow-2xl backdrop-blur-[40px] backdrop-saturate-150 supports-[backdrop-filter]:bg-popover/70 dark:bg-popover/82"
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

          <div className="flex min-h-0 flex-1">
            <PaletteResults
              className="flex-1"
              flat={state.flat}
              onSetSelIndex={state.setSelIndex}
              query={state.query}
              scope={state.scope}
              sections={state.sections}
              selIndex={state.selIndex}
            />
            <aside className="cmdscroll w-[296px] flex-none overflow-y-auto border-border/60 border-l bg-muted/30">
              <PreviewSwitch preview={state.preview} />
            </aside>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

/**
 * Right-pane preview switch. Task 8 replaces this with the real per-kind
 * preview components (dispatch / chat / taskRun / taskSched / info). Until then
 * it shows a neutral placeholder when nothing is selected, or the selected
 * item's title as a lightweight readout.
 *
 * `dispatch` has no `title` field (it carries the goal term + formations), so
 * until the real preview lands it just renders the placeholder.
 *
 * TODO(Task 8): render a discriminated preview per `preview.type`.
 */
function PreviewSwitch({ preview }: { preview: PreviewData | null }): React.JSX.Element {
  if (!preview) {
    return <div className="p-4 text-muted-foreground text-xs">选择左侧条目查看详情</div>
  }
  const title =
    preview.type === 'dispatch'
      ? '把目标交给 Agent'
      : preview.type === 'taskRun'
        ? preview.run.goal
        : preview.type === 'taskSched'
          ? (preview.task.name ?? preview.task.cron)
          : preview.title
  return (
    <div className="space-y-2 p-4">
      <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">预览</div>
      <div className="font-medium text-foreground text-sm">{title}</div>
    </div>
  )
}
