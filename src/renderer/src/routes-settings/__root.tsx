import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

import { TitleBar } from '@/components/title-bar'
import { ScrollArea } from '@/components/ui/scroll-area'

export const Route = createRootRoute({ component: SettingsLayout })

const TABS = [
  { to: '/providers', label: 'Providers' },
  { to: '/mcp', label: 'MCP Servers' },
  { to: '/web-search', label: 'Web Search' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/', label: 'General' },
  { to: '/permissions', label: 'Permissions' },
  { to: '/about', label: 'About' },
] as const

function SettingsLayout(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col pt-7">
      <TitleBar />
      <nav className="flex shrink-0 gap-1 border-b px-4 py-2 text-sm">
        {TABS.map((t) => (
          <Link
            // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
            activeProps={{ 'data-status': 'active' } as any}
            className="rounded px-3 py-1 hover:bg-accent data-[status=active]:bg-accent"
            key={t.to}
            // biome-ignore lint/suspicious/noExplicitAny: `to` constrained by Router's typed registry, widened over TABS const
            to={t.to as any}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <main className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="p-6">
            <Outlet />
          </div>
        </ScrollArea>
      </main>
    </div>
  )
}
