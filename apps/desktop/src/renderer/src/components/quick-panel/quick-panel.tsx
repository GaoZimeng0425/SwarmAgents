// Top-level quick panel component. In palette mode: input + slash list + results.
// In chat mode: delegates to QuickPanelChat (Task 10).
//
// All navigation happens via swarmApi.quickPanelFocusMain, which focuses the
// main window and routes it there — the quick panel is its own window, so
// in-renderer routing (useNavigate) wouldn't affect the visible surface.
import { useEffect, useMemo } from 'react'
import { useTheme } from 'next-themes'

import { useSubmitPrompt } from '@/hooks/use-messages'
import { usePaletteData } from '@/hooks/use-palette-data'
import { swarmApi } from '@/lib/api'
import type { Callbacks } from '@/lib/palette/build-items'
import { useComposerDefaults } from '@/stores/composer-defaults'
import { QuickPanelChat } from './quick-panel-chat'
import { QuickPanelInput } from './quick-panel-input'
import { QuickPanelResults } from './quick-panel-results'
import { useQuickPanelState } from './use-quick-panel-state'

const THEME_ORDER = ['system', 'light', 'dark'] as const

export function QuickPanel(): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  const setComposerAgent = useComposerDefaults((s) => s.setAgentType)
  const submitPrompt = useSubmitPrompt()
  const inputs = usePaletteData(true)

  const cb: Callbacks = useMemo(
    () => ({
      navigate: (to) => {
        void swarmApi.quickPanelFocusMain({ navigate: to })
      },
      openSettings: (section) => {
        void swarmApi.quickPanelFocusMain({ settings: section })
      },
      cycleTheme: () => {
        const current = (theme ?? 'system') as (typeof THEME_ORDER)[number]
        const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length]
        setTheme(next)
      },
      exportMarkdown: (sessionId) => {
        if (sessionId) {
          void swarmApi.exportSessionMarkdown(sessionId)
          void swarmApi.quickPanelHide()
        }
      },
      setComposerAgent: (id) => {
        setComposerAgent(id)
        void swarmApi.quickPanelFocusMain({ navigate: '/' })
      },
      openArtifact: (ref) => {
        void window.swarm.openPath(ref)
      },
      submitPrompt: async (prompt, agentType) => {
        const r = await submitPrompt.mutateAsync({ prompt, options: { agentType }, forceNew: true })
        void swarmApi.quickPanelFocusMain({ navigate: `/session/${r.sessionId}` })
        return r
      },
    }),
    [theme, setTheme, setComposerAgent, submitPrompt]
  )

  const state = useQuickPanelState({ inputs, cb })

  // Resize the panel to fit palette results. Each result row is ~32px; the
  // input is ~52px. The cap at 480 is enforced by main's resizeQuickPanel.
  useEffect(() => {
    if (state.mode !== 'palette') return
    const inputHeight = 52
    const rowHeight = 32
    const resultsHeight = state.flat.length * rowHeight
    void swarmApi.quickPanelResize(inputHeight + resultsHeight)
  }, [state.mode, state.flat.length])

  if (state.mode === 'chat') {
    return <QuickPanelChat />
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-popover/82 backdrop-blur-[40px]">
      <QuickPanelInput
        onKeyDown={state.onKeyDown}
        onQueryChange={state.setQuery}
        query={state.query}
        selIndex={state.selIndex}
        showSlashList={state.showSlashList}
        slashItems={state.slashItems}
      />
      <QuickPanelResults
        flat={state.flat}
        onSetSelIndex={state.setSelIndex}
        sections={state.sections}
        selIndex={state.selIndex}
      />
    </div>
  )
}
