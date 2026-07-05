// apps/desktop/src/renderer/src/components/palette/use-palette-state.ts
// The single controller for the ⌘K palette: owns query/selection/preview state
// and the keyboard handler. Composes getScope (Task 1), buildItems (Task 3),
// and selectPalette (Task 4). Task 7's shell renders purely from the return.
import { useEffect, useMemo, useState } from 'react'

import { type BuildInputs, buildItems, type Callbacks } from '../../lib/palette/build-items'
import { getScope } from '../../lib/palette/scope'
import { selectPalette } from '../../lib/palette/select-palette'

// The prefix chars that switch scope. Backspace on exactly one of these (a
// "lone prefix") clears the scope back to mixed; any other backspace is left
// to the <input> to delete the trailing char normally.
const PREFIX_CHARS = new Set(['>', '@', '#', '/'])

export function usePaletteState(args: { inputs: BuildInputs; cb: Callbacks; open: boolean; close: () => void }) {
  const { inputs, cb, open, close } = args
  const [query, setQuery] = useState('')
  // Re-derive scope every render from the raw query — no separate state to keep
  // in sync with it.
  const { mode, term } = getScope(query)

  const items = useMemo(() => buildItems(mode, term, inputs, cb), [mode, term, inputs, cb])
  const { sections, flat } = useMemo(() => selectPalette(mode, items), [mode, items])

  const [selIndex, setSelIndex] = useState(0)
  // Any query change invalidates the list, so snap selection back to the top.
  useEffect(() => {
    setSelIndex(0)
  }, [query])
  // Closing the palette should always reopen to a clean state.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const selected = flat[selIndex] ?? null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selected?.run()
    } else if (e.key === 'Escape') {
      // preventDefault: stop Chromium from "reverting" the <input> to its last
      // committed value, which would fight with setQuery('') below.
      e.preventDefault()
      // Clear an in-progress query first; only close when already empty.
      if (query) setQuery('')
      else close()
    } else if (e.key === 'Backspace' && PREFIX_CHARS.has(query)) {
      e.preventDefault()
      setQuery('')
    }
  }

  return {
    query,
    setQuery,
    scope: mode,
    sections,
    flat,
    selIndex,
    setSelIndex,
    selected,
    preview: selected?.preview ?? null,
    onKeyDown,
  }
}
