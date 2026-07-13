// 52px header bar at the top of the chat column — a persistent "what session am
// I in" strip matching Hi-fi 3b: session title + live status pill + context-fill
// readout. Status colors follow the app's existing accent system (primary =
// brand orange, amber for awaiting), not 3b's blue.

import { ChatIdBadge } from '@/components/chat-id-badge'

export type SessionHeaderStatus = 'running' | 'awaiting' | 'idle'

type Props = {
  title: string
  status: SessionHeaderStatus
  /** Latest turn's context-window fill, 0–100. Omitted when unknown. */
  contextPct?: number
  /** Source session id when this session was created via "fork from here".
   *  Omitted for non-fork sessions. Client-side lineage only — the renderer
   *  records it when swarmApi.forkSession resolves, so it does not survive a
   *  restart. */
  forkedFrom?: string
}

export function SessionHeader({ title, status, contextPct, forkedFrom }: Props): React.JSX.Element {
  return (
    // Window dragging is owned globally by <TitleBar> (top strip, mounted in
    // __root); interactive controls opt out of it via the global no-drag rule
    // in globals.css.
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-border/60 border-b px-4">
      <ChatIdBadge />
      <span className="truncate font-semibold text-[13.5px]">{title}</span>
      {forkedFrom && (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          forked from session
        </span>
      )}
      {status === 'running' && (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-1 font-medium text-[11.5px] text-primary">
          <span className="size-1.5 rounded-full bg-primary" />
          运行中
        </span>
      )}
      {status === 'awaiting' && (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 font-medium text-[11.5px] text-amber-500">
          <span className="size-1.5 rounded-full bg-amber-500" />
          等待审批
        </span>
      )}
      <div className="flex-1" />
      {contextPct !== undefined && (
        <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">上下文 {contextPct}%</span>
      )}
    </div>
  )
}
