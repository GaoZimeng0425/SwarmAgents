// Router-derived replacement for the deleted useSettingsDialog store. The
// settings modal's open/section state is a projection of the `settings` search
// param (declared on __root, so it works from any route). openSettings/close
// navigate; section switching passes { replace: true } so the back stack isn't
// cluttered with per-section entries.
import { useNavigate, useSearch } from '@tanstack/react-router'

import { isValidSection, type SettingsSection } from '@/stores/settings-dialog'

export type SettingsNav = {
  open: boolean
  section: SettingsSection | null
  openSettings: (section?: SettingsSection, opts?: { replace?: boolean }) => Promise<void>
  close: () => Promise<void>
}

export function useSettingsNav(): SettingsNav {
  const navigate = useNavigate()
  // strict:false reads the root-level search (the settings param lives on __root).
  const { settings } = useSearch({ strict: false })
  const section = isValidSection(settings) ? settings : null

  return {
    open: section !== null,
    section,
    openSettings: (section: SettingsSection = 'general', opts?: { replace?: boolean }) =>
      navigate({
        search: (prev) => ({ ...prev, settings: section }),
        replace: opts?.replace,
      } as never),
    close: () =>
      navigate({ search: (prev) => ({ ...prev, settings: undefined }) } as never),
  }
}
