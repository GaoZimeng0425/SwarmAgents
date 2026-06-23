// src/renderer/src/components/settings-dialog.tsx
import { Bot, Boxes, DollarSign, Info, Lock, Search, Settings as SettingsIcon, Sparkles } from 'lucide-react'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AboutView } from '@/components/views/about-view'
import { BudgetsView } from '@/components/views/budgets-view'
import { GeneralView } from '@/components/views/general-view'
import { McpServersView } from '@/components/views/mcp-servers-view'
import { PermissionsView } from '@/components/views/permissions-view'
import { ProvidersView } from '@/components/views/providers-view'
import { SkillsView } from '@/components/views/skills-view'
import { WebSearchView } from '@/components/views/web-search-view'
import { cn } from '@/lib/utils'
import { type SettingsSection, useSettingsDialog } from '@/stores/settings-dialog'

const SECTIONS: { key: SettingsSection; label: string; icon: typeof SettingsIcon; View: () => React.JSX.Element }[] = [
  { key: 'general', label: 'General', icon: SettingsIcon, View: GeneralView },
  { key: 'providers', label: 'Providers', icon: Bot, View: ProvidersView },
  { key: 'mcp', label: 'MCP Servers', icon: Boxes, View: McpServersView },
  { key: 'web-search', label: 'Web Search', icon: Search, View: WebSearchView },
  { key: 'skills', label: 'Skills', icon: Sparkles, View: SkillsView },
  { key: 'budgets', label: 'Budgets', icon: DollarSign, View: BudgetsView },
  { key: 'permissions', label: 'Permissions', icon: Lock, View: PermissionsView },
  { key: 'about', label: 'About', icon: Info, View: AboutView },
]

export function SettingsDialog(): React.JSX.Element {
  const { open, section, openSettings, close } = useSettingsDialog()
  const active = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]
  const ActiveView = active.View

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close()
      }}
      open={open}
    >
      {/* No close button; base-ui Dialog dismisses on backdrop click / Esc. */}
      <DialogContent className="flex h-[80vh] max-w-3xl gap-0 overflow-hidden p-0 sm:max-w-3xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-muted/30 px-3 py-4">
          {SECTIONS.map(({ key, label, icon: Icon }) => (
            <button
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                key === section && 'bg-accent text-foreground'
              )}
              key={key}
              onClick={() => openSettings(key)}
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
