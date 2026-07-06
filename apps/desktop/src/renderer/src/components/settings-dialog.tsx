import { Dialog, DialogContent, DialogTitle } from '@swarm/ui'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useSettingsNav } from '@/hooks/use-settings-nav'
import { GROUP_ORDER, SECTIONS_REGISTRY } from '@/stores/settings-dialog'

export function SettingsDialog(): React.JSX.Element {
  const { open, section, openSettings, close } = useSettingsNav()
  const active = SECTIONS_REGISTRY.find((s) => s.key === section) ?? SECTIONS_REGISTRY[0]
  const ActiveView = active.View

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close()
      }}
      open={open}
    >
      {/* No close button; base-ui Dialog dismisses on backdrop click / Esc. */}
      <DialogContent
        className="flex h-[90vh] w-[90vw] max-w-[90vw] gap-0 overflow-hidden p-0 sm:max-w-[90vw]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-muted/30 px-3 py-4">
          {GROUP_ORDER.map((group) => (
            <div className="mb-3.5 flex flex-col gap-0.5" key={group}>
              <p className="px-2.5 pt-1.5 pb-0.5 font-semibold text-[10.5px] text-muted-foreground/70 uppercase tracking-wide">
                {group}
              </p>
              {SECTIONS_REGISTRY.filter((s) => s.group === group).map((s) => {
                const Icon = s.icon
                const isActive = s.key === section
                return (
                  <button
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left font-medium text-[13px] transition-colors ${
                      isActive ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'
                    }`}
                    key={s.key}
                    onClick={() => openSettings(s.key, { replace: true })}
                    type="button"
                  >
                    <span
                      className="flex size-[23px] shrink-0 items-center justify-center rounded-md"
                      style={{ backgroundColor: s.iconBg }}
                    >
                      <Icon className="size-[13px] text-white" />
                    </span>
                    {s.label}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-6">
            <ActiveView />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
