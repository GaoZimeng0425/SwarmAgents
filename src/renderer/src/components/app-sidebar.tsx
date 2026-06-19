import { Link } from '@tanstack/react-router'
import { BarChart3, CalendarClock, Settings, Sparkles } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

export function AppSidebar(): React.JSX.Element {
  return (
    <Sidebar>
      {/* The unified TopBar in __root.tsx owns the window's top strip (sidebar
          toggle + nav arrows). The sidebar's own content starts below it; the
          pt-9 on sidebar-inner (see ui/sidebar.tsx) clears the toolbar height. */}
      <SidebarContent>
        <SessionList />
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className="flex items-center gap-2"
                  // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over route const
                  to={'/scheduled' as any}
                >
                  <CalendarClock />
                  <span>定时任务</span>
                </Link>
              }
              tooltip="定时任务"
            />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className="flex items-center gap-2"
                  // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over route const
                  to={'/usage' as any}
                >
                  <BarChart3 />
                  <span>用量统计</span>
                </Link>
              }
              tooltip="用量统计"
            />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                  activeProps={{ 'data-active': 'true' } as any}
                  className="flex items-center gap-2"
                  // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over route const
                  to={'/skills' as any}
                >
                  <Sparkles />
                  <span>Skills</span>
                </Link>
              }
              tooltip="Skills"
            />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => void window.swarm.openSettings()} tooltip="Settings">
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ThemeToggle />
      </SidebarFooter>
    </Sidebar>
  )
}
