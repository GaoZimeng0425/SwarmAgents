import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import {
  Bot,
  Boxes,
  DollarSign,
  Info,
  Lock,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react'

import { TitleBar } from '@/components/title-bar'
import { ScrollArea } from '@/components/ui/scroll-area'

export const Route = createRootRoute({ component: SettingsLayout })

const NAV = [
  { to: '/', label: 'General', icon: SettingsIcon },
  { to: '/providers', label: 'Providers', icon: Bot },
  { to: '/mcp', label: 'MCP Servers', icon: Boxes },
  { to: '/web-search', label: 'Web Search', icon: Search },
  { to: '/budgets', label: 'Budgets', icon: DollarSign },
  { to: '/permissions', label: 'Permissions', icon: Lock },
  { to: '/about', label: 'About', icon: Info },
] as const

function SettingsLayout(): React.JSX.Element {
  return (
    <div className="flex h-svh overflow-hidden">
      <TitleBar />
      {/* macOS System Settings style: left sidebar nav + right content.
          pt-12 clears the macOS traffic lights (~28px) plus breathing room. */}
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 px-3 pb-4 pt-12">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <Link
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
          <div className="min-h-full p-6 pt-12">
            <Outlet />
          </div>
        </ScrollArea>
      </main>
    </div>
  )
}
