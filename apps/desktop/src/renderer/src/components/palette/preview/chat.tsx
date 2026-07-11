// apps/desktop/src/renderer/src/components/palette/preview/chat.tsx
// Lazy preview of the last ~20 chat messages for a session. Fetches the raw
// MessageEvent[] via swarmApi.getMessageEvents and filters to message.progress events whose
// nested TaskEvent is an llm.message. Assistant messages are rendered as
// markdown (code blocks, lists, emphasis) via the shared Markdown component;
// user/tool messages stay plain text since they rarely contain markdown.
import { useQuery } from '@tanstack/react-query'

import { swarmApi } from '../../../lib/api'
import type { PreviewData } from '../../../lib/palette/types'
import { Markdown } from '../../markdown'

export type ChatPreviewData = Extract<PreviewData, { type: 'chat' }>

export function ChatPreview({ data }: { data: ChatPreviewData }): React.JSX.Element {
  const q = useQuery({
    queryKey: ['session-preview', data.sessionId],
    queryFn: () => swarmApi.getMessageEvents(data.sessionId),
    enabled: !!data.sessionId,
    staleTime: 30_000,
  })

  if (q.isLoading) {
    return <div className="p-4 text-muted-foreground text-xs">加载中…</div>
  }

  // MessageEvent.event is a UIEvent; when its kind is 'message.progress' it carries a
  // nested TaskEvent on `.event`, which for llm.message holds {role, content}.
  const msgs = (q.data ?? [])
    .filter((r) => r.event.kind === 'message.progress' && (r.event as any).event?.kind === 'llm.message')
    .slice(-20)

  return (
    <div className="p-4">
      <h4 className="font-semibold text-sm">{data.title}</h4>
      <div className="mt-2 space-y-2 text-xs">
        {msgs.length === 0 && <p className="text-muted-foreground">暂无消息</p>}
        {msgs.map((m, i) => {
          const msg = (m.event as any).event
          const role = msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'Agent' : '工具'
          const content = String(msg.content ?? '')
          return (
            <div className="space-y-0.5" key={i}>
              <span className="font-medium">{role}</span>
              {msg.role === 'assistant' ? (
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
