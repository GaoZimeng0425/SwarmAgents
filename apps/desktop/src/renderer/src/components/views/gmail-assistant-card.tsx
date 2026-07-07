// The thread-level Agent assistant card. Renders the streaming summary, the
// extracted todos, and the suggested reply with a "采用并回复" draft area.
// The draft is copy-only (the app is Gmail-readonly).
import { useState } from 'react'
import { Button } from '@swarm/ui'
import { Check, Copy, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { Streamdown } from 'streamdown'

import type { ThreadAnalysisState } from '@/hooks/use-thread-analysis'

export function GmailAssistantCard({
  analysis,
  messageCount,
  onRegenerate,
}: {
  analysis: ThreadAnalysisState
  messageCount: number
  onRegenerate: () => void
}): React.JSX.Element | null {
  const [draftOpen, setDraftOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

  if (analysis.phase === 'idle') return null

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-violet-500/20 shadow-sm">
      <div className="flex items-center gap-2 border-violet-500/15 border-b bg-linear-to-br from-violet-500/10 to-primary/10 px-4 py-2.5">
        <span className="flex size-5 items-center justify-center rounded-md bg-linear-to-br from-violet-500 to-primary">
          <Sparkles className="size-3 text-white" />
        </span>
        <span className="font-semibold text-[13px] text-violet-700 dark:text-violet-300">Agent 助手</span>
        <span className="ml-auto text-[10.5px] text-violet-500/80">已读取全部 {messageCount} 条消息</span>
      </div>

      <div className="flex flex-col gap-3 bg-secondary p-4">
        {analysis.phase === 'streaming' && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="size-3.5 animate-spin" /> 分析中…
          </div>
        )}
        {(analysis.phase === 'streaming' || analysis.phase === 'done') && (
          <Streamdown className="text-[13px] text-foreground/90">
            {analysis.phase === 'done' ? analysis.summary : analysis.summaryText}
          </Streamdown>
        )}

        {analysis.phase === 'done' && analysis.todos.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10.5px] text-muted-foreground uppercase tracking-wide">抽取的待办</p>
            {analysis.todos.map((td, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Todo has no stable id field
              <div className="flex items-start gap-2" key={i}>
                <span className="mt-0.5 size-4 shrink-0 rounded border border-border" />
                <span className="text-[12.5px] text-foreground/80">{td.t}</span>
                {td.due && td.dueLabel ? (
                  <span className="ml-1 rounded bg-red-500/10 px-1.5 py-0.5 font-semibold text-[10.5px] text-red-600 dark:text-red-400">
                    {td.dueLabel}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {analysis.phase === 'done' && analysis.suggest && (
          <div className="rounded-lg border border-border/60 bg-background/50 p-3">
            <p className="mb-1.5 text-[10.5px] text-muted-foreground uppercase tracking-wide">建议回复</p>
            <p className="text-[12.5px] text-foreground/80">{analysis.suggest}</p>
            <div className="mt-2 flex gap-2">
              <Button
                onClick={() => {
                  setDraft(analysis.suggest)
                  setDraftOpen(true)
                }}
                size="sm"
              >
                采用并回复
              </Button>
              <Button onClick={onRegenerate} size="sm" variant="outline">
                <RefreshCw className="size-3.5" /> 重新生成
              </Button>
            </div>
          </div>
        )}

        {draftOpen && (
          <div className="flex flex-col gap-2">
            <textarea
              className="min-h-24 w-full rounded-md border border-border bg-background p-2 text-[13px]"
              onChange={(e) => setDraft(e.target.value)}
              value={draft}
            />
            <div className="flex items-center gap-2">
              <Button onClick={() => void copy()} size="sm" variant="outline">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? '已复制' : '复制到剪贴板'}
              </Button>
              <span className="text-[11px] text-muted-foreground">复制后到 Gmail 网页/客户端发送（应用保持只读）</span>
            </div>
          </div>
        )}

        {analysis.phase === 'error' && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-destructive">{analysis.error}</span>
            <Button onClick={onRegenerate} size="sm" variant="outline">
              重试
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
