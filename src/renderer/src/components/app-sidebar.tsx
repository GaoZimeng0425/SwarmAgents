import { Link } from '@tanstack/react-router'
import { BarChart3, CalendarClock, Settings } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import { Sidebar, SidebarContent, SidebarFooter } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettingsDialog } from '@/stores/settings-dialog'

const iconBtn =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-4'

export function AppSidebar(): React.JSX.Element {
  const openSettings = useSettingsDialog((s) => s.openSettings)

  return (
    <Sidebar variant="inset">
      {/* inset variant: window tinted with sidebar color, content floats as rounded card */}
      <SidebarContent>
        <SessionList />
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className={iconBtn}
                  // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                  to={'/scheduled' as any}
                >
                  <CalendarClock />
                </Link>
              }
            />
            <TooltipContent side="top">定时任务</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className={iconBtn}
                  // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                  to={'/usage' as any}
                >
                  <BarChart3 />
                </Link>
              }
            />
            <TooltipContent side="top">用量统计</TooltipContent>
          </Tooltip>

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
