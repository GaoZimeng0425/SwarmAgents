// src/renderer/src/components/chat-id-badge.tsx
//
// Compact chip showing the current session id, rendered inline at the left of
// the chat header (SessionHeader). Click copies the full id.
import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@swarm/ui'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

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
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-muted/50 px-2 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
