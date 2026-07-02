import { Sidebar, SidebarContent, SidebarFooter, Tooltip, TooltipContent, TooltipTrigger } from '@swarm/ui'
import { Settings } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import { useSettingsDialog } from '@/stores/settings-dialog'

const iconBtn =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-4'

export function AppSidebar(): React.JSX.Element {
  const openSettings = useSettingsDialog((s) => s.openSettings)

  return (
    // floating variant: the sidebar is a rounded, shadowed card with a gap around
    // it (showing the window vibrancy) — no hard border line on the chat's left.
    // The card reaches near the top so it wraps the native traffic lights inside
    // its rounded top corner; the inner pt-9 (ui/sidebar.tsx) keeps the session
    // list clear of that top control band. The fixed TopBar — not the card —
    // owns the toggle, so it stays reachable when the sidebar is collapsed.
    <Sidebar variant="floating">
      <SidebarContent className="pt-10">
        <SessionList />
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button className={iconBtn} onClick={() => openSettings()} type="button">
                  <Settings />
                </button>
              }
            />
            <TooltipContent side="top">设置</TooltipContent>
          </Tooltip>

          <div className="flex-1" />
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
