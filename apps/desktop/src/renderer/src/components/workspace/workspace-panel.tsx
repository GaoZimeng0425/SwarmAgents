// 300px four-tab workspace (plan/timeline/artifacts/approval) replacing RightPanel.

import { useState } from 'react'
import type { MessageRecord } from '@shared/lib/apply-event'
import type { PermissionDecision, SessionSummary } from '@swarm/protocol'
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@swarm/ui'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'

import type { PlanGroup } from '@/components/plan-panel'
import { PlanPanel } from '@/components/plan-panel'
import { buildTimeline } from '@/lib/workspace/build-timeline'
import { usePermissionStore } from '@/stores/permission'
import { ApprovalTab } from './approval-tab'
import { ArtifactsTab } from './artifacts-tab'
import { TimelineTab } from './timeline-tab'

type Props = {
  messages: MessageRecord[]
  planGroups: PlanGroup[]
  session?: SessionSummary
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

export function WorkspacePanel({ messages, planGroups, session, onDecide }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<'plan' | 'timeline' | 'artifacts' | 'approval'>('plan')
  const queue = usePermissionStore((s) => s.queue)
  const pendingCount = session ? queue.filter((p) => p.sessionId === session.id).length : 0
  const timelineRows = buildTimeline(messages)

  if (collapsed) {
    return (
      <div className="flex h-full shrink-0 flex-col items-center gap-2 border-border/60 border-l bg-(--surface-panel) py-3">
        <Button aria-label="展开工作区" onClick={() => setCollapsed(false)} size="icon" variant="ghost">
          <PanelRightOpen className="size-5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-border/60 border-l bg-(--surface-panel)">
      <Tabs
        className="flex min-h-0 flex-1 flex-col gap-0"
        onValueChange={(v) => setTab(v as 'plan' | 'timeline' | 'artifacts' | 'approval')}
        value={tab}
      >
        <div className="flex h-[52px] items-center justify-between border-border/60 border-b px-2">
          <TabsList className="bg-transparent p-0">
            <TabsTrigger
              className="data-[state=active]:rounded-t-lg data-[state=active]:bg-background data-[state=active]:font-semibold"
              value="plan"
            >
              计划
            </TabsTrigger>
            <TabsTrigger
              className="data-[state=active]:rounded-t-lg data-[state=active]:bg-background data-[state=active]:font-semibold"
              value="timeline"
            >
              时间线
            </TabsTrigger>
            <TabsTrigger
              className="data-[state=active]:rounded-t-lg data-[state=active]:bg-background data-[state=active]:font-semibold"
              value="artifacts"
            >
              产出物
            </TabsTrigger>
            <TabsTrigger
              className="gap-1 data-[state=active]:rounded-t-lg data-[state=active]:bg-background data-[state=active]:font-semibold"
              value="approval"
            >
              审批
              {pendingCount > 0 && (
                <span className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-amber-600 px-1 font-bold text-[9.5px] text-white tabular-nums dark:bg-amber-500 dark:text-neutral-900">
                  {pendingCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
          <Button
            aria-label="收起工作区"
            className="size-7 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            onClick={() => setCollapsed(true)}
            size="icon"
            variant="ghost"
          >
            <PanelRightClose className="size-4" />
          </Button>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="plan">
          <div className="cmdscroll min-h-0 flex-1 overflow-y-auto">
            <PlanPanel groups={planGroups} />
          </div>
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="timeline">
          <TimelineTab rows={timelineRows} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="artifacts">
          <ArtifactsTab cwd={session?.cwd} messages={messages} />
        </TabsContent>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="approval">
          <ApprovalTab onDecide={onDecide} sessionId={session?.id ?? null} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
