import { Plus } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { hydrateSession } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { useSessionsStore } from '@/stores/sessions'

export function SessionList(): React.JSX.Element {
  const qc = useQueryClient()
  const sessions = useSessionsStore((s) => s.sessions)
  const selected = useSessionsStore((s) => s.selectedSessionId)
  const select = useSessionsStore((s) => s.select)

  const onNew = async (): Promise<void> => {
    try {
      const { sessionId } = await swarmApi.createSession()
      select(sessionId)
    } catch (err) {
      toast.error('Could not start a new chat. Configure an API key in Settings.')
      console.error(err)
    }
  }

  const onSelect = (id: string): void => {
    select(id)
    void hydrateSession(qc, id)
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <Button className="w-full justify-start gap-2" onClick={() => void onNew()} variant="outline">
        <Plus className="size-4" />
        New chat
      </Button>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1">
          {sessions.map((s) => (
            <button
              aria-current={selected === s.id ? 'true' : undefined}
              className={cn(
                'truncate rounded px-3 py-2 text-left text-sm hover:bg-accent',
                selected === s.id && 'bg-accent font-medium',
              )}
              key={s.id}
              onClick={() => onSelect(s.id)}
              title={s.title ?? 'Untitled chat'}
              type="button"
            >
              {s.title ?? 'Untitled chat'}
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-2 text-muted-foreground text-xs">No chats yet. Click &quot;New chat&quot; above.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
