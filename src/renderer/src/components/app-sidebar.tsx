import { Link } from '@tanstack/react-router'
import { ListChecks, Settings, Sparkles } from 'lucide-react'

import { ThemeToggle } from '@/components/theme-toggle'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

const NAV = [
  { to: '/', label: 'Tasks', icon: ListChecks },
  { to: '/skills', label: 'Skills', icon: Sparkles },
] as const

export function AppSidebar(): React.JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    render={
                      <Link
                        // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                        activeProps={{ 'data-active': 'true' } as any}
                        className="flex items-center gap-2"
                        // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over NAV const
                        to={to as any}
                      >
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    }
                    tooltip={label}
                  />
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    void window.swarm.openSettings()
                  }}
                  tooltip="Settings"
                >
                  <Settings />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <ThemeToggle />
      </SidebarFooter>
    </Sidebar>
  )
}
