import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { hydrateSession, useTasks } from '@/hooks/use-tasks'
import { swarmApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/stores/sessions'

type LiveStatus = 'running' | 'awaiting' | 'idle'

export function SessionList(): React.JSX.Element {
  const qc = useQueryClient()
  const sessions = useSessionsStore((s) => s.sessions)
  const selected = useSessionsStore((s) => s.selectedSessionId)
  const select = useSessionsStore((s) => s.select)
  const tasks = useTasks()

  // Derive a live run-status per session so parallel work is visible while you
  // view another conversation (events for every session stream into the cache).
  const statusBySession = useMemo(() => {
    const m = new Map<string, LiveStatus>()
    for (const t of tasks) {
      const cur = m.get(t.sessionId)
      if (cur === 'awaiting') continue
      if (t.status === 'awaiting_user') m.set(t.sessionId, 'awaiting')
      else if (t.status === 'running' || t.status === 'pending') m.set(t.sessionId, 'running')
      else if (!cur) m.set(t.sessionId, 'idle')
    }
    return m
  }, [tasks])

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
          {sessions.map((s) => {
            const status = statusBySession.get(s.id) ?? 'idle'
            return (
              <button
                aria-current={selected === s.id ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent',
                  selected === s.id && 'bg-accent font-medium'
                )}
                key={s.id}
                onClick={() => onSelect(s.id)}
                title={s.title ?? 'Untitled chat'}
                type="button"
              >
                <span className="flex-1 truncate">{s.title ?? 'Untitled chat'}</span>
                {status === 'running' && <Loader2 aria-label="Running" className="size-3.5 shrink-0 animate-spin" />}
                {status === 'awaiting' && (
                  <span aria-label="Awaiting input" className="size-2 shrink-0 rounded-full bg-amber-500" role="img" />
                )}
              </button>
            )
          })}
          {sessions.length === 0 && (
            <p className="px-3 py-2 text-muted-foreground text-xs">No chats yet. Click &quot;New chat&quot; above.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
