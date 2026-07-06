// 64px icon rail — the app's primary navigation. Two grouped sections
// (场景 / 服务) rendered from rail-config.ts, plus a footer (设置). Theme
// lives in Settings → 通用. Route items navigate via TanStack Router; the
// single action item (编队) opens the agents section of the SettingsDialog.
// Active state is derived from useLocation so prefix matches (对话) and
// shared routes (日历+自动化 both on /scheduled) light up correctly.

import { Tooltip, TooltipContent, TooltipTrigger } from '@swarm/ui'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { Settings } from 'lucide-react'

import { isActive, RAIL_SECTIONS, type RailItem } from '@/components/rail-config'
import { useSettingsDialog } from '@/stores/settings-dialog'

const iconBtn =
  'flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground [&_svg]:size-5'

export function AppRail(): React.JSX.Element {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const openSettings = useSettingsDialog((s) => s.openSettings)

  // Action items don't navigate; the formation item opens the agents settings.
  const runAction = (item: RailItem) => {
    if (item.key === 'formation') openSettings('agents')
  }

  const onClick = (item: RailItem) => {
    if (item.target.kind === 'route') {
      // '/session/' is a prefix match target, not a real route — route to the
      // landing where the user picks/starts a conversation.
      navigate({ to: item.target.to === '/session/' ? '/' : item.target.to })
    } else {
      runAction(item)
    }
  }

  return (
    // Full-height 64px column pinned left, translucent over window vibrancy.
    // pt-9 keeps icons below the traffic-light band (the fixed TopBar owns
    // that strip and overlays the rail's top).
    <nav aria-label="主导航" className="flex w-16 shrink-0 flex-col items-center gap-1 bg-sidebar pt-9 pb-3">
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

      {/* Footer: settings (modal). Theme lives in Settings → 通用 now. */}
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
