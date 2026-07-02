// 3-column grid of service shortcuts, rendered under the "New chat" button.
// Owns the service list so the sidebar footer can stay minimal (Settings +
// ThemeToggle only). Each cell reuses the footer's icon-button styling.
import { Link } from '@tanstack/react-router'
import { BarChart3, CalendarClock, TrendingUp, Video } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const iconBtn =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-4'

export type ServiceEntry = {
  icon: React.ComponentType<{ className?: string }>
  to: string
  label: string
}

// Ordered: calendar first (was 定时任务; the view now also shows calendar
// events, hence the 日历 relabel).
export const SERVICES: ServiceEntry[] = [
  { icon: CalendarClock, to: '/scheduled', label: '日历' },
  { icon: BarChart3, to: '/usage', label: '用量统计' },
  { icon: TrendingUp, to: '/trending', label: 'GitHub 趋势' },
  { icon: Video, to: '/bilibili', label: 'Bilibili 收藏' },
]

export function ServiceGrid(): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1">
      {SERVICES.map(({ icon: Icon, to, label }) => (
        <Tooltip key={to}>
          <TooltipTrigger
            render={
              <Link
                // biome-ignore lint/suspicious/noExplicitAny: TanStack Router activeProps generic over route tree
                activeProps={{ 'data-active': 'true' } as any}
                className={iconBtn}
                // biome-ignore lint/suspicious/noExplicitAny: `to` widened over Router's typed registry
                to={to as any}
              >
                <Icon />
              </Link>
            }
          />
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
