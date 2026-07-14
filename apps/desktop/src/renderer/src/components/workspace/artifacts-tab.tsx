// apps/desktop/src/renderer/src/components/workspace/artifacts-tab.tsx
// Artifacts tab — session-extracted file outputs + bilibili analyses.

import type { MessageRecord } from '@shared/lib/apply-event'
import { useQuery } from '@tanstack/react-query'
import { FileText, Film } from 'lucide-react'

import { useNow } from '@/hooks/use-now'
import { swarmApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format-time'
import { type ArtifactRow, buildArtifacts } from '@/lib/workspace/build-artifacts'

type Props = {
  messages: MessageRecord[]
  cwd?: string
}

function open(row: ArtifactRow): void {
  if (row.ref.startsWith('BV') || row.ref.startsWith('bv')) void window.swarm.bilibili.open(row.ref)
  else void window.swarm.openPath(row.ref)
}

export function ArtifactsTab({ messages, cwd }: Props): React.JSX.Element {
  const now = useNow()
  const { data: cwdArtifacts } = useQuery({
    queryKey: ['workspace', 'artifacts'],
    queryFn: () => swarmApi.listArtifacts({ limit: 50 }),
    staleTime: 60_000,
  })
  const rows = buildArtifacts(messages, cwdArtifacts ?? [], cwd)

  if (rows.length === 0) {
    return <div className="p-4 text-muted-foreground text-sm">暂无产出物</div>
  }
  return (
    <ul className="cmdscroll flex-1 space-y-1 overflow-y-auto p-3">
      {rows.map((r) => (
        <li key={r.id}>
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50"
            onClick={() => open(r)}
            type="button"
          >
            {r.ref.startsWith('BV') || r.ref.startsWith('bv') ? (
              <Film className="size-3.5 shrink-0 text-emerald-500" />
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium">{r.name}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{r.origin}</span>
            {r.modifiedAt && (
              <span className="shrink-0 text-muted-foreground/70">{formatRelativeTime(r.modifiedAt, now)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
