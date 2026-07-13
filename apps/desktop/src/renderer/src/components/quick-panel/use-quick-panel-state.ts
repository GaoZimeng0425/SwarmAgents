// State machine for the quick panel. Two modes:
//   palette — reuses the existing buildItems + getScope pipeline.
//   chat    — mini agent conversation (entered via /agent + Tab).
//
// Slash commands: when the query starts with '/', we check if it matches a
// known slash command prefix before falling through to getScope's file scope.
// This resolves the conflict: '/' is both the file-scope prefix AND the slash
// command trigger. Slash commands take priority.
import { useEffect, useMemo, useState } from 'react'

import { swarmApi } from '@/lib/api'
import { type BuildInputs, buildItems, type Callbacks } from '@/lib/palette/build-items'
import { getScope } from '@/lib/palette/scope'
import { selectPalette } from '@/lib/palette/select-palette'

export type QuickPanelMode = 'palette' | 'chat'

export type SlashCommand = {
  id: string
  label: string
  desc: string
}

// MVP: only /agent. Extensible shape — add entries here to surface more.
export const SLASH_COMMANDS: SlashCommand[] = [{ id: 'agent', label: '/agent', desc: '进入对话模式' }]

function matchingSlashCommands(query: string): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const lower = query.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.label.toLowerCase().startsWith(lower))
}

export type QuickPanelState = {
  mode: QuickPanelMode
  query: string
  setQuery: (q: string) => void
  scope: ReturnType<typeof getScope>['mode']
  sections: ReturnType<typeof selectPalette>['sections']
  flat: ReturnType<typeof selectPalette>['flat']
  selIndex: number
  setSelIndex: (i: number) => void
  selected: ReturnType<typeof selectPalette>['flat'][number] | null
  onKeyDown: (e: React.KeyboardEvent) => void
  sessionId: string | null
  showSlashList: boolean
  slashItems: SlashCommand[]
  pickSlashCommand: (cmd: SlashCommand) => void
}

export function useQuickPanelState(args: { inputs: BuildInputs; cb: Callbacks }): QuickPanelState {
  const { inputs, cb } = args
  const [mode, setMode] = useState<QuickPanelMode>('palette')
  const [query, setQuery] = useState('')
  const [selIndex, setSelIndex] = useState(0)
  // sessionId is held in state so a future chat-mode task can assign it; the
  // MVP never sets it (always null), so the setter is intentionally omitted.
  const [sessionId] = useState<string | null>(null)

  // Slash command matching — checked before getScope.
  const slashItems = useMemo(() => matchingSlashCommands(query), [query])
  const showSlashList = slashItems.length > 0

  // Palette scope + items (only computed in palette mode).
  const { mode: scope, term } = getScope(query)
  const items = useMemo(() => buildItems(scope, term, inputs, cb), [scope, term, inputs, cb])
  const { sections, flat } = useMemo(() => selectPalette(scope, items), [scope, items])

  useEffect(() => {
    setSelIndex(0)
  }, [query])

  const selected = flat[selIndex] ?? null

  const pickSlashCommand = (cmd: SlashCommand): void => {
    if (cmd.id === 'agent') {
      setMode('chat')
      setQuery('')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Esc always closes the panel (both modes).
    if (e.key === 'Escape') {
      e.preventDefault()
      void swarmApi.quickPanelHide()
      return
    }

    // Slash list: Tab or Enter picks the highlighted slash command.
    if (showSlashList && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault()
      const target = slashItems[selIndex] ?? slashItems[0]
      if (target) pickSlashCommand(target)
      return
    }

    // Palette mode keyboard (arrow nav + enter).
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selected?.run()
    }
  }

  return {
    mode,
    query,
    setQuery,
    scope,
    sections,
    flat,
    selIndex,
    setSelIndex,
    selected,
    onKeyDown,
    sessionId,
    showSlashList,
    slashItems,
    pickSlashCommand,
  }
}
