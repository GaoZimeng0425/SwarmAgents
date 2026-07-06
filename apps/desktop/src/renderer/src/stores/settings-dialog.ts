import { create } from 'zustand'

// Settings is presented as a single dialog with an internal nav. Each section
// maps 1:1 to what used to be a /settings/* route.
export type SettingsSection =
  | 'general'
  | 'providers'
  | 'mcp'
  | 'web-search'
  | 'weather'
  | 'gmail'
  | 'calendar'
  | 'skills'
  | 'bilibili'
  | 'budgets'
  | 'permissions'
  | 'about'

const SECTIONS: SettingsSection[] = [
  'general',
  'providers',
  'mcp',
  'web-search',
  'weather',
  'gmail',
  'calendar',
  'skills',
  'bilibili',
  'budgets',
  'permissions',
  'about',
]

// Map a legacy /settings[/<section>] route (still sent by the menu / deep-link
// IPC) onto a dialog section. Unknown tails fall back to General.
export function routeToSection(route: string): SettingsSection {
  const tail = route.replace(/^\/settings\/?/, '')
  return (SECTIONS as string[]).includes(tail) ? (tail as SettingsSection) : 'general'
}

type SettingsDialogStore = {
  open: boolean
  section: SettingsSection
  openSettings: (section?: SettingsSection) => void
  close: () => void
}

export const useSettingsDialog = create<SettingsDialogStore>((set) => ({
  open: false,
  section: 'general',
  openSettings: (section = 'general') => set({ open: true, section }),
  close: () => set({ open: false }),
}))
