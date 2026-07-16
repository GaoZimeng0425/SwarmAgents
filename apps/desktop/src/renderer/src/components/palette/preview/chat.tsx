// apps/desktop/src/renderer/src/components/palette/preview/chat.tsx
// Lazy preview of the last ~20 chat messages for a session. Loads the session's
// entries (getSessionEntries) and flattens them via buildSegments, then renders
// the user/assistant text. Assistant messages render as markdown; user/tool
// messages stay plain text.
import { buildSegments, emptySessionView, hydrate } from '@swarm/shared'
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '../../../lib/api'
import type { PreviewData } from '../../../lib/palette/types'
import { Markdown } from '../../markdown'

export type ChatPreviewData = Extract<PreviewData, { type: 'chat' }>

export function ChatPreview({ data }: { data: ChatPreviewData }): React.JSX.Element {
  const q = useQuery({
    queryKey: ['session-preview', data.sessionId],
    queryFn: () => swarmApi.getSessionEntries(data.sessionId),
    enabled: !!data.sessionId,
    staleTime: 30_000,
  })

  if (q.isLoading) {
    return <div className="p-4 text-muted-foreground text-xs">加载中…</div>
  }

  const segments = buildSegments(hydrate(emptySessionView(), q.data ?? []))
  const msgs = segments.filter((s) => s.kind === 'user' || s.kind === 'assistant').slice(-20)

  return (
    <div className="p-4">
      <h4 className="font-semibold text-sm">{data.title}</h4>
      <div className="mt-2 space-y-2 text-xs">
        {msgs.length === 0 && <p className="text-muted-foreground">暂无消息</p>}
        {msgs.map((m) => {
          const role = m.kind === 'user' ? '你' : 'Agent'
          const content = m.kind === 'user' || m.kind === 'assistant' ? m.text : ''
          return (
            <div className="space-y-0.5" key={m.key}>
              <span className="font-medium">{role}</span>
              {m.kind === 'assistant' ? (
                <Markdown className="text-xs">{content}</Markdown>
              ) : (
                <p className="text-muted-foreground">{content}</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
