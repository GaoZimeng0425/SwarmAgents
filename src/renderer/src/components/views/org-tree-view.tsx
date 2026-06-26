import { useState } from 'react'

import { type OrgNode, buildOrgForest } from '@shared/agents/org-tree'
import type { AgentDefinition, AgentListItem } from '@shared/types/agent'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useAgentMutations } from '@/hooks/use-agent-mutations'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { AgentDetail } from './agent-detail'
import { AgentFormSheet } from './agent-form-sheet'

const MAX_CAPS = 3

/** One agent card: name, role/id, team + scope badges, capped capabilities, action buttons. */
function AgentNodeCard({
  agent,
  isActive,
  onClick,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  agent: AgentListItem
  isActive: boolean
  onClick: () => void
  onEdit: (a: AgentListItem) => void
  onDuplicate: (a: AgentListItem) => void
  onDelete: (a: AgentListItem) => void
}): React.JSX.Element {
  const caps = agent.capabilities ?? []
  const shown = caps.slice(0, MAX_CAPS)
  const extra = caps.length - shown.length
  return (
    <div
      className={cn(
        'group flex items-start gap-2 rounded-lg border bg-card p-2.5 transition-colors hover:bg-accent',
        isActive && 'border-primary ring-1 ring-primary'
      )}
    >
      <button className="min-w-0 flex-1 text-left" onClick={onClick} type="button">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{agent.name}</span>
          <span className="truncate font-mono text-muted-foreground text-xs">{agent.role ?? agent.id}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {agent.team && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">{agent.team}</span>
          )}
          <span className="text-muted-foreground text-xs">scope: {agent.toolScope}</span>
          {shown.map((c) => (
            <span key={c} className="rounded bg-secondary px-1 py-0.5 text-secondary-foreground text-[10px]">
              {c}
            </span>
          ))}
          {extra > 0 && <span className="text-muted-foreground text-[10px]">+{extra} more</span>}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {agent.builtin ? (
          <Button aria-label={`Duplicate ${agent.name}`} onClick={() => onDuplicate(agent)} size="icon" variant="ghost">
            <Copy className="size-4" />
          </Button>
        ) : (
          <>
            <Button aria-label={`Edit ${agent.name}`} onClick={() => onEdit(agent)} size="icon" variant="ghost">
              <Pencil className="size-4" />
            </Button>
            <Button
              aria-label={`Delete ${agent.name}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(agent)}
              size="icon"
              variant="ghost"
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

const noop = (): void => {}

/** Recursive node: a card plus an indented, guide-lined list of children. */
function OrgTreeNode({
  node,
  expanded,
  onToggle,
  onEdit = noop,
  onDuplicate = noop,
  onDelete = noop,
}: {
  node: OrgNode
  expanded: string | null
  onToggle: (id: string) => void
  onEdit?: (a: AgentListItem) => void
  onDuplicate?: (a: AgentListItem) => void
  onDelete?: (a: AgentListItem) => void
}): React.JSX.Element {
  return (
    <li>
      <AgentNodeCard
        agent={node.agent as AgentListItem}
        isActive={expanded === node.agent.id}
        onClick={() => onToggle(node.agent.id)}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
      {node.children.length > 0 && (
        <ul className="mt-1 ml-4 flex flex-col gap-1 border-l pl-3">
          {node.children.map((child) => (
            <OrgTreeNode
              key={child.agent.id}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Indented org tree from buildOrgForest. Hierarchy trees first, then a
 *  flat "Independent Agents" group for team-less, childless, non-CEO roots. */
export function OrgTree({
  agents,
  expanded,
  onToggle,
  onEdit = noop,
  onDuplicate = noop,
  onDelete = noop,
}: {
  agents: AgentDefinition[]
  expanded: string | null
  onToggle: (id: string) => void
  onEdit?: (a: AgentListItem) => void
  onDuplicate?: (a: AgentListItem) => void
  onDelete?: (a: AgentListItem) => void
}): React.JSX.Element {
  const forest = buildOrgForest(agents)
  const isIndependent = (n: OrgNode): boolean =>
    n.children.length === 0 && n.agent.role !== 'ceo' && !n.agent.team
  const hierarchy = forest.filter((n) => !isIndependent(n))
  const independents = forest.filter(isIndependent)
  return (
    <div className="flex flex-col gap-4 overflow-x-auto">
      <ul className="flex flex-col gap-1">
        {hierarchy.map((node) => (
          <OrgTreeNode
            key={node.agent.id}
            node={node}
            expanded={expanded}
            onToggle={onToggle}
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
          />
        ))}
      </ul>
      {independents.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Independent Agents
          </span>
          <ul className="flex flex-col gap-1">
            {independents.map((node) => (
              <OrgTreeNode
                key={node.agent.id}
                node={node}
                expanded={expanded}
                onToggle={onToggle}
                onEdit={onEdit}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

type SheetState =
  | { open: false }
  | { open: true; mode: 'create' | 'edit' | 'duplicate'; agent?: AgentListItem }

/** Stateful wrapper: single-select org tree with CRUD affordances and a detail panel. */
export function OrgTreeView({ agents }: { agents: AgentDefinition[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sheet, setSheet] = useState<SheetState>({ open: false })
  const [pendingDelete, setPendingDelete] = useState<AgentListItem | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const { save, remove } = useAgentMutations()

  const toggle = (id: string): void => setExpanded((prev) => (prev === id ? null : id))
  const selected = expanded ? agents.find((a) => a.id === expanded) : undefined

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

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button aria-label="New agent" className="gap-1.5" onClick={() => setSheet({ open: true, mode: 'create' })}>
          <Plus className="size-4" />
          New Agent
        </Button>
      </div>

      <OrgTree
        agents={agents}
        expanded={expanded}
        onToggle={toggle}
        onEdit={(a) => setSheet({ open: true, mode: 'edit', agent: a })}
        onDuplicate={(a) => setSheet({ open: true, mode: 'duplicate', agent: a })}
        onDelete={(a) => setPendingDelete(a)}
      />
      {selected && <AgentDetail agent={selected} />}

      <AgentFormSheet
        agent={sheet.open ? sheet.agent : undefined}
        agents={agents}
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
