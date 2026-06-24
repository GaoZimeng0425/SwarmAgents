import { create } from 'zustand'

// Session search is a command-palette dialog opened from the sidebar Search
// row or the global ⌘K shortcut. State lives here so both triggers (and the
// dialog itself) share one source of truth, mirroring useSettingsDialog.
type SearchDialogStore = {
  open: boolean
  openSearch: () => void
  toggle: () => void
  close: () => void
}

export const useSearchDialog = create<SearchDialogStore>((set) => ({
  open: false,
  openSearch: () => set({ open: true }),
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}))
