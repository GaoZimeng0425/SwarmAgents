import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

import { TitleBar } from '@/components/title-bar'

export const Route = createRootRoute({ component: SettingsLayout })

const TABS = [
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
            key={t.to}
            to={t.to as any}
            className="rounded px-3 py-1 hover:bg-accent data-[status=active]:bg-accent"
            activeProps={{ 'data-status': 'active' } as any}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}
