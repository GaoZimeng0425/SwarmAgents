import { Dialog, DialogContent, DialogTitle } from '@swarm/ui'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useSettingsNav } from '@/hooks/use-settings-nav'
import { cn } from '@/lib/utils'
import { SECTIONS_REGISTRY } from '@/stores/settings-dialog'

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
          {SECTIONS_REGISTRY.map(({ key, label, icon: Icon }) => (
            <button
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                key === section && 'bg-accent text-foreground'
              )}
              key={key}
              // Section switch = replace, so the back stack isn't cluttered
              // with one entry per visited section.
              onClick={() => openSettings(key, { replace: true })}
              type="button"
            >
              <Icon className="size-4" />
              {label}
            </button>
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
