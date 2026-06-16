import { MessageSquarePlus } from 'lucide-react'

/** Shown at `/` when no session is open. Does not create a session — the
 *  "New chat" button in the sidebar is the only way to start one. */
export function EmptyState(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <MessageSquarePlus className="size-10 opacity-40" />
      <p className="font-medium text-sm">No conversation open</p>
      <p className="max-w-xs text-xs opacity-70">Click "New chat" or pick a conversation from the sidebar to begin.</p>
    </div>
  )
}
