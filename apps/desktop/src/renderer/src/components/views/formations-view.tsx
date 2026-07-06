// apps/desktop/src/renderer/src/components/views/formations-view.tsx
import { useEffect, useState } from 'react'
import type { AgentDefinition, AgentListItem } from '@swarm/protocol'
import { buildDelegationEdges } from '@swarm/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@swarm/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'

import { useAgentActivity } from '@/hooks/use-agent-activity'
import { useAgentMutations } from '@/hooks/use-agent-mutations'
import { swarmApi } from '@/lib/api'
import { AgentDetail } from './agent-detail'
import { AgentFormSheet } from './agent-form-sheet'
import { DelegationLinks } from './delegation-links'
import { OrgTree } from './org-tree-view'

type SheetState = { open: false } | { open: true; mode: 'create' | 'edit' | 'duplicate'; agent?: AgentListItem }

export function FormationsView(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { save, remove, restoreDefaults } = useAgentMutations()
  const [restoring, setRestoring] = useState(false)
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', 'settings'],
    queryFn: () => swarmApi.listAgents(),
    staleTime: 60_000,
  })
  const activity = useAgentActivity()

  // Hot-reload when agent files change on disk.
  useEffect(
    () =>
      swarmApi.subscribeEvents((e) => {
        if (e.kind === 'agents.changed') void queryClient.invalidateQueries({ queryKey: ['agents', 'settings'] })
      }),
    [queryClient]
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<SheetState>({ open: false })
  const [pendingDelete, setPendingDelete] = useState<AgentListItem | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const list = agents ?? []
  const edges = buildDelegationEdges(list)
  const highlightedIds = new Set(edges.filter((e) => e.from === selectedId).map((e) => e.to))
  const selected = selectedId ? list.find((a) => a.id === selectedId) : undefined
  const activeCount = activity.size

  const onSubmit = async (def: AgentDefinition): Promise<void> => {
    const r = await save(def)
    if (r.ok) {
      setSheet({ open: false })
      setError(undefined)
    } else {
      setError(r.message)
      toast.error(r.message)
    }
  }
  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const r = await remove(pendingDelete.id)
    if (!r.ok) toast.error(r.message)
    setPendingDelete(null)
  }
  const onRestoreDefaults = async (): Promise<void> => {
    setRestoring(true)
    try {
      await restoreDefaults()
    } finally {
      setRestoring(false)
    }
  }

  if (isLoading) return <div className="p-8 text-muted-foreground text-sm">Loading agents…</div>

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-border/60 border-b px-6">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-sm">{list.length} 个 Agent</h1>
          {activeCount > 0 && (
            <span className="flex items-center gap-1.5 text-[#3478f6] text-xs">
              <span className="size-[6px] rounded-full bg-[#3478f6] shadow-[0_0_0_3px_rgba(52,120,246,.18)]" />
              {activeCount} 正在工作
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={restoring} onClick={onRestoreDefaults} size="sm" variant="outline">
            {restoring ? '恢复中…' : '恢复默认'}
          </Button>
          <Button className="gap-1.5" onClick={() => setSheet({ open: true, mode: 'create' })} size="sm">
            <Plus className="size-4" />
            新建 Agent
          </Button>
        </div>
      </div>

      {/* Body: tree + detail */}
      <div className="flex min-h-0 flex-1">
        <div className="cmdscroll min-w-0 flex-1 overflow-y-auto p-[22px_28px]">
          {list.length === 0 ? (
            <p className="text-muted-foreground text-sm">暂无 Agent。</p>
          ) : (
            <OrgTree
              activity={activity}
              agents={list}
              expanded={selectedId}
              highlightedIds={highlightedIds}
              onDelete={(a) => setPendingDelete(a)}
              onDuplicate={(a) => setSheet({ open: true, mode: 'duplicate', agent: a })}
              onEdit={(a) => setSheet({ open: true, mode: 'edit', agent: a })}
              onToggle={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
          )}
        </div>

        {/* Detail column (sibling, NOT a Sheet) */}
        <aside className="cmdscroll w-[328px] shrink-0 overflow-y-auto border-border/60 border-l bg-secondary p-4">
          {selected ? (
            <>
              <AgentDetail agent={selected} />
              <DelegationLinks agentId={selected.id} agents={list} edges={edges} onSelect={(id) => setSelectedId(id)} />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">选择一个 Agent 查看详情</p>
          )}
        </aside>
      </div>

      {/* Form sheet + delete dialog (portaled at page root) */}
      <AgentFormSheet
        agent={sheet.open ? sheet.agent : undefined}
        agents={list}
        error={error}
        mode={sheet.open ? sheet.mode : 'create'}
        onOpenChange={(o) => {
          if (!o) {
            setSheet({ open: false })
            setError(undefined)
          }
        }}
        onSubmit={onSubmit}
        open={sheet.open}
      />
      <AlertDialog onOpenChange={(o) => !o && setPendingDelete(null)} open={pendingDelete !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This removes its AGENT.md from disk. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
