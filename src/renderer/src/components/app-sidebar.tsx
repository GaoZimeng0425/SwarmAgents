import { Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Settings, Sparkles } from 'lucide-react'

import { SessionList } from '@/components/session-list'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar'

export function AppSidebar(): React.JSX.Element {
  const router = useRouter()
  return (
    <Sidebar>
      {/* Top drag strip aligned with the macOS traffic lights: pl clears the
          lights, the strip itself is draggable, the controls opt back out. */}
      <div
        className="flex h-9 shrink-0 items-center gap-0.5 pr-2 pl-[78px]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SidebarTrigger aria-label="Toggle sidebar" className="text-muted-foreground" />
          <Button
            aria-label="Back"
            className="text-muted-foreground"
            onClick={() => router.history.back()}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <Button
            aria-label="Forward"
            className="text-muted-foreground"
            onClick={() => router.history.forward()}
            size="icon-sm"
            variant="ghost"
          >
            <ArrowRight />
          </Button>
        </div>
      </div>
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
