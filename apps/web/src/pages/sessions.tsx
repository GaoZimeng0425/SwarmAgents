import type { SessionSummary } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { useQuery } from '@tanstack/react-query'
import { Settings } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { useConnection } from '@/stores/connection-store'

export function SessionsPage(): React.JSX.Element {
  const { client } = useConnection()
  const navigate = useNavigate()

  const {
    data: sessions,
    error,
    refetch,
    isFetching,
  } = useQuery<SessionSummary[]>({
    queryKey: ['sessions'],
    queryFn: () => client!.listSessions(),
    enabled: !!client,
    staleTime: 30_000,
  })

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col bg-background">
      <header className="flex items-center justify-between border-border border-b px-4 py-3">
        <h1 className="font-semibold text-foreground text-lg">会话列表</h1>
        <Link to="/settings">
          <Button aria-label="设置" size="icon" variant="ghost">
            <Settings className="size-5" />
          </Button>
        </Link>
      </header>

      {error && (
        <div className="border-destructive/30 border-b bg-destructive/5 px-4 py-2">
          <p className="text-destructive text-sm">{error instanceof Error ? error.message : String(error)}</p>
          <Button onClick={() => void refetch()} size="sm" variant="link">
            重试
          </Button>
        </div>
      )}

      <ul className="flex-1 divide-y divide-border">
        {sessions?.map((s) => (
          <li key={s.id}>
            <button
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent"
              onClick={() => navigate(`/session/${s.id}`)}
              type="button"
            >
              <span className="flex-1 truncate pr-2">
                <span className="block truncate font-medium text-foreground">
                  {s.pinned && '📌 '}
                  {s.title ?? '未命名会话'}
                </span>
                <span className="text-muted-foreground text-xs">
                  {s.taskCount} 条消息 · {new Date(s.lastActiveAt).toLocaleDateString()}
                </span>
              </span>
            </button>
          </li>
        ))}
        {!isFetching && sessions?.length === 0 && (
          <li className="px-4 py-12 text-center text-muted-foreground text-sm">暂无会话</li>
        )}
      </ul>
    </div>
  )
}
