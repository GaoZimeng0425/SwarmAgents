// 64px icon rail — the app's primary navigation. Two grouped sections
// (场景 / 服务) rendered from rail-config.ts, plus a footer (工具 + 用量 + 设置).
// Theme lives in Settings → 通用. All items are routes; 编队 goes to
// /formations. Active state is derived from useLocation so prefix matches
// (对话) light up correctly.

import { Tooltip, TooltipContent, TooltipTrigger } from '@swarm/ui'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { BarChart3, Settings } from 'lucide-react'

import { isActive, RAIL_SECTIONS, type RailItem } from '@/components/rail-config'
import { ToolsPopover } from '@/components/tools-popover'
import { useSettingsNav } from '@/hooks/use-settings-nav'

const iconBtn =
  'flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-5'

export function AppRail(): React.JSX.Element {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { openSettings } = useSettingsNav()

  const onClick = (item: RailItem) => {
    if (item.target.kind !== 'route') return
    void navigate({ to: item.target.to })
  }

  return (
    // Full-height 64px column pinned left, translucent over window vibrancy.
    // pt-9 keeps icons below the macOS traffic lights (positioned over the rail's
    // top-left). The absolute strip below turns that top band into the window's
    // drag region — there is no separate title bar.
    <nav
      aria-label="主导航"
      className="relative flex w-16 shrink-0 flex-col items-center gap-1 bg-(--surface-rail) pt-9 pb-3"
    >
      {/* Window drag region over the traffic-light band (no native title bar). */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-9"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />
      {RAIL_SECTIONS.map((section, sectionIdx) => (
        <div className="flex flex-col items-center gap-1" key={section.id}>
          {sectionIdx > 0 && <div aria-hidden="true" className="my-1 h-px w-6 bg-sidebar-border" />}
          {section.items.map((item) => {
            const Icon = item.icon
            const active = isActive(item, pathname)
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger
                  render={
                    <button
                      aria-current={active ? 'page' : undefined}
                      aria-label={item.label}
                      className={iconBtn}
                      data-active={active || undefined}
                      onClick={() => onClick(item)}
                      type="button"
                    >
                      <Icon />
                    </button>
                  }
                />
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      ))}

      <div className="flex-1" />

      {/* Footer: 工具 (global MCP/skills toggles) + 用量 (route) + 设置 (modal).
          Theme lives in Settings → 通用. */}
      <div className="[&_button]:size-11 [&_button]:rounded-xl [&_svg]:size-5">
        <ToolsPopover />
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-current={pathname === '/usage' ? 'page' : undefined}
              aria-label="用量"
              className={iconBtn}
              data-active={pathname === '/usage' || undefined}
              onClick={() => navigate({ to: '/usage' })}
              type="button"
            >
              <BarChart3 />
            </button>
          }
        />
        <TooltipContent side="right">用量</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button aria-label="设置" className={iconBtn} onClick={() => openSettings()} type="button">
              <Settings />
            </button>
          }
        />
        <TooltipContent side="right">设置</TooltipContent>
      </Tooltip>
    </nav>
  )
}
