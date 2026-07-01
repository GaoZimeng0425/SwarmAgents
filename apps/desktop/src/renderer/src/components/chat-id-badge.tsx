// src/renderer/src/components/chat-id-badge.tsx
//
// Floating chip at the chat area's top-left corner showing the current session
// id. Click copies the full id. Pinned absolutely against the chat column (the
// column itself never scrolls, so this behaves like a fixed overlay while the
// inner conversation thread scrolls) — kept inside the column rather than
// viewport-fixed so it tracks the sidebar and clears the macOS title bar.
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/stores/sessions'

export function ChatIdBadge(): React.JSX.Element | null {
  const sessionId = useSessionsStore((s) => s.selectedSessionId)
  const [copied, setCopied] = useState(false)

  if (!sessionId) return null

  const onCopy = (): void => {
    void navigator.clipboard.writeText(sessionId)
    toast.success('Chat ID copied')
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  // Session ids are ULIDs (26 chars); show the head, full value in tooltip/clipboard.
  const short = sessionId.slice(0, 8)

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Copy chat ID"
        className="absolute top-2 left-2 z-20 inline-flex h-7 items-center gap-1.5 rounded-full bg-muted/60 px-2.5 font-mono text-muted-foreground text-xs backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onCopy}
        type="button"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        <span className="tabular-nums">{short}</span>
      </TooltipTrigger>
      <TooltipContent>Copy chat ID · {sessionId}</TooltipContent>
    </Tooltip>
  )
}
