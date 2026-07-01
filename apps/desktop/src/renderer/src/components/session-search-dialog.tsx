import { useHotkey } from '@tanstack/react-hotkeys'
import { useNavigate } from '@tanstack/react-router'
import { CalendarClock, MessageSquare } from 'lucide-react'

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useSearchDialog } from '@/stores/search-dialog'
import { useSessionsStore } from '@/stores/sessions'

// Command-palette search over chats. Opened from the sidebar Search row or the
// global ⌘K shortcut; cmdk handles the live title filtering as you type.
export function SessionSearchDialog(): React.JSX.Element {
  const open = useSearchDialog((s) => s.open)
  const close = useSearchDialog((s) => s.close)
  const toggle = useSearchDialog((s) => s.toggle)
  const sessions = useSessionsStore((s) => s.sessions)
  const navigate = useNavigate()

  // Global ⌘K / Ctrl+K toggles the palette. ⌘B (sidebar) is handled elsewhere.
  // `Mod` resolves to ⌘ on macOS and Ctrl elsewhere; for Meta/Ctrl combos
  // react-hotkeys fires even while a text field is focused (ignoreInputs=false).
  useHotkey('Mod+K', () => toggle(), { stopPropagation: false })

  const select = (id: string): void => {
    close()
    void navigate({ to: '/session/$sessionId', params: { sessionId: id } })
  }

  const systemSession = sessions.find((s) => s.isSystem)
  const chats = sessions.filter((s) => !s.isSystem)

  return (
    <CommandDialog
      description="Find a chat by title"
      onOpenChange={(next) => !next && close()}
      open={open}
      title="Search chats"
    >
      <Command>
        <CommandInput placeholder="Search chats…" />
        <CommandList>
          <CommandEmpty>No matching chats.</CommandEmpty>
          {systemSession && (
            <CommandGroup heading="定时任务">
              <CommandItem key={systemSession.id} onSelect={() => select(systemSession.id)} value="定时任务 scheduled">
                <CalendarClock />
                定时任务
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Chats">
            {chats.map((s) => {
              const title = s.title ?? 'Untitled chat'
              return (
                <CommandItem key={s.id} onSelect={() => select(s.id)} value={`${title} ${s.id}`}>
                  <MessageSquare />
                  <span className="truncate">{title}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
