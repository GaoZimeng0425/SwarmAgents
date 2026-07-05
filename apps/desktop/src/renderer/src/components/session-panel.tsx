// Secondary panel that hosts the conversation list. Shown only in the
// conversation scene (see isConversationScene); the caller decides visibility.
// Settings + theme live in the rail footer now, so this panel is just the list.

import { SessionList } from '@/components/session-list'

export function SessionPanel(): React.JSX.Element {
  return (
    // 236px column (design-spec conversation-list width) flush to the rail.
    // pt-9 clears the traffic-light band shared with the rail + fixed TopBar.
    // SessionList already manages its own scrolling internally (its own
    // ScrollArea at session-list.tsx:444), so we must NOT wrap it again — a
    // double ScrollArea would fight over the viewport height.
    <aside className="flex w-[236px] shrink-0 flex-col border-sidebar-border border-r bg-sidebar pt-9">
      {/* min-h-0 so SessionList's inner ScrollArea (session-list.tsx:444) can
          shrink and scroll within this flex column instead of overflowing it. */}
      <div className="min-h-0 flex-1">
        <SessionList />
      </div>
    </aside>
  )
}
