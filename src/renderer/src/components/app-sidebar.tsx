import { Link } from '@tanstack/react-router'
import { Settings, Sparkles } from 'lucide-react'

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
      <SidebarContent>
        <SessionList />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
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
