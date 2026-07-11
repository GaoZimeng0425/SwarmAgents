import type { CronJobSummary } from '@swarm/protocol'
import { Button } from '@swarm/ui'
import { formatDistanceToNow } from 'date-fns'
import { Trash2 } from 'lucide-react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { useCancelCronJob } from '@/hooks/use-cron'

type Props = { jobs: CronJobSummary[]; isLoading: boolean }

export function CronPanel({ jobs, isLoading }: Props): React.JSX.Element {
  const cancel = useCancelCronJob()
  if (!isLoading && jobs.length === 0) {
    return <p className="px-4 py-6 text-muted-foreground text-sm">No scheduled tasks in this chat.</p>
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 p-3">
        {jobs.map((j) => (
          <div className="rounded-lg border bg-background/50 p-3 text-sm" key={j.id}>
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{j.name ?? '(unnamed task)'}</span>
              <Button
                aria-label="Cancel task"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => cancel.mutate(j.id)}
                size="icon"
                variant="ghost"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <p className="mt-1 font-mono text-muted-foreground text-xs">{j.cron}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Next: {j.nextRun ? formatDistanceToNow(j.nextRun, { addSuffix: true }) : 'n/a'}
            </p>
            <p className="mt-2 line-clamp-2 text-foreground/80 text-xs">{j.prompt}</p>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
