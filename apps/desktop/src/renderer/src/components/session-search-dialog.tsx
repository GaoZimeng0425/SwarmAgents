// apps/desktop/src/renderer/src/components/session-search-dialog.tsx
// The ⌘K command palette. Kept as the mount point (imported by __root.tsx and
// session-list.tsx) — the body now delegates to the two-column palette shell.
// The global ⌘K / Ctrl+K toggle is still wired here; PaletteDialog reads its
// own `close` from the search-dialog store.
import { useHotkey } from '@tanstack/react-hotkeys'

import { useSearchDialog } from '../stores/search-dialog'
import { PaletteDialog } from './palette/palette-dialog'

export function SessionSearchDialog(): React.JSX.Element {
  const open = useSearchDialog((s) => s.open)
  const toggle = useSearchDialog((s) => s.toggle)
  // `Mod` resolves to ⌘ on macOS and Ctrl elsewhere; for Meta/Ctrl combos
  // react-hotkeys fires even while a text field is focused.
  useHotkey('Mod+K', () => toggle(), { stopPropagation: false })
  return <PaletteDialog open={open} />
}
