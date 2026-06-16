import { useState } from 'react'
import type { PlanTodo } from '@shared/types/task'
import { Brain, ListChecks, PanelRightClose, PanelRightOpen } from 'lucide-react'

import { MemoryPanel } from '@/components/memory-panel'
import { PlanPanel } from '@/components/plan-panel'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMemory } from '@/hooks/use-memory'

type Props = { plan: PlanTodo[] }

/** Collapsible right-hand panel hosting the Working Plan and Memory tabs. */
export function RightPanel({ plan }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const [tab, setTab] = useState<'plan' | 'memory'>('plan')
  const { entries, isError, refetch } = useMemory()
  const done = plan.filter((t) => t.status === 'completed').length

  if (collapsed) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center gap-3 border-l bg-sidebar/50 py-4 backdrop-blur-sm">
        <Button
          aria-label="Expand panel"
          className="size-8 rounded-lg transition-colors hover:bg-primary/10 hover:text-primary"
          onClick={() => setCollapsed(false)}
          size="icon"
          variant="ghost"
        >
          <PanelRightOpen className="size-5" />
        </Button>
        <button
          aria-label="Open plan"
          className="flex flex-col items-center gap-1"
          onClick={() => {
            setTab('plan')
            setCollapsed(false)
          }}
          type="button"
        >
          <ListChecks className="size-5 text-primary/60" />
          {plan.length > 0 && (
            <span className="font-bold text-[10px] text-primary/80 tabular-nums">
              {done}/{plan.length}
            </span>
          )}
        </button>
        <button
          aria-label="Open memory"
          className="flex flex-col items-center gap-1"
          onClick={() => {
            setTab('memory')
            setCollapsed(false)
          }}
          type="button"
        >
          <Brain className="size-5 text-primary/60" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l bg-sidebar/50 backdrop-blur-sm">
      <Tabs
        className="flex min-h-0 flex-1 flex-col gap-0"
        onValueChange={(v) => setTab(v as 'plan' | 'memory')}
        value={tab}
      >
        <div className="flex h-11 items-center justify-between border-border/40 border-b px-2">
          <TabsList className="bg-transparent">
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
          </TabsList>
          <Button
            aria-label="Collapse panel"
            className="size-7 rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            onClick={() => setCollapsed(true)}
            size="icon"
            variant="ghost"
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="plan">
          <PlanPanel todos={plan} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="memory">
          <MemoryPanel entries={entries} isError={isError} onRetry={refetch} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
