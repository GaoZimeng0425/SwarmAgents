import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Bot, Boxes, DollarSign, Info, Lock, Search, Settings as SettingsIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getSettingsReturnHref } from '@/lib/settings-return'

export const Route = createFileRoute('/settings')({ component: SettingsLayout })

const NAV = [
  { to: '/settings', label: 'General', icon: SettingsIcon },
  { to: '/settings/providers', label: 'Providers', icon: Bot },
  { to: '/settings/mcp', label: 'MCP Servers', icon: Boxes },
  { to: '/settings/web-search', label: 'Web Search', icon: Search },
  { to: '/settings/budgets', label: 'Budgets', icon: DollarSign },
  { to: '/settings/permissions', label: 'Permissions', icon: Lock },
  { to: '/settings/about', label: 'About', icon: Info },
] as const

function SettingsLayout(): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-[var(--window-content)]">
      {/* Draggable top strip with a Done affordance, offset clear of the macOS
          traffic lights. Mirrors the main window TopBar in routes/__root.tsx. */}
      <div
        className="fixed inset-x-0 top-0 z-30 flex h-9 shrink-0 items-center bg-[var(--window-content)]/80 px-2 backdrop-blur-md"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="pl-[70px]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Button
            className="gap-1 text-muted-foreground"
            // biome-ignore lint/suspicious/noExplicitAny: stored href widened over Router's typed registry
            onClick={() => void navigate({ to: getSettingsReturnHref() as any })}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="size-4" /> 完成
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 pt-9">
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 px-3 pt-3 pb-4">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <Link
                activeOptions={{ exact: item.to === '/settings' }}
                // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                activeProps={{ 'data-status': 'active' } as any}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-accent data-[status=active]:text-foreground"
                key={item.to}
                // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over NAV const
                to={item.to as any}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <main className="min-h-0 flex-1 bg-[var(--window-content)]">
          <ScrollArea className="h-full" edgeFade>
            <div className="min-h-full p-6">
              <Outlet />
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  )
}
