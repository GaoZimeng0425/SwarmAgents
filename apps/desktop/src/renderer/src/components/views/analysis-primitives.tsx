// Shared UI primitives for the card-based analysis panels (article / trending /
// bilibili). Each panel renders the same phase-based content ladder; these
// components factor out the repeated JSX so the panels only differ in their
// header, action buttons, and the structured result card.

import { Loader2, Sparkles } from 'lucide-react'
import { Streamdown } from 'streamdown'

import { cn } from '@/lib/utils'

/** Skeleton shown while the agent runs but no streamed text has arrived yet. */
export function AnalyzingPlaceholder({ label = 'AI 分析中…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5 font-semibold text-[13px] text-violet-600 dark:text-violet-300">
        <Loader2 className="size-3.5 animate-spin" /> {label}
      </div>
      <div className="h-16 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 animate-pulse rounded-xl bg-muted" />
    </div>
  )
}

/** Idle empty-state: Sparkles icon + a hint pointing at the action button. */
export function AnalysisEmptyState({ prompt }: { prompt: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <Sparkles className="size-7 text-muted-foreground/40" />
      <p className="text-muted-foreground text-sm">{prompt}</p>
    </div>
  )
}

/** Inline error text + optional retry button. */
export function AnalysisErrorBlock({ error }: { error: string }): React.JSX.Element {
  return <p className="text-destructive text-sm">{error}</p>
}

export type AnalysisContentProps = {
  /** Current phase from useAnalysisStream. */
  phase: 'idle' | 'streaming' | 'done' | 'error'
  /** Accumulated streamed text (from streaming or done state). */
  streamText: string
  /** Error message (from error state). */
  error: string | null
  /** Whether a mutation is pending (bilibili uses this alongside the hook). */
  isPending?: boolean
  /** The structured result card to render in the done state. */
  resultCard?: React.ReactNode
  /** Optional markdown briefing shown above the result card in done state. */
  doneMarkdown?: string
  /** Label for the analyzing placeholder spinner. */
  analyzingLabel?: string
  /** Prompt for the idle empty state. */
  emptyPrompt: string
  /** Extra className on the streaming Streamdown wrapper. */
  className?: string
}

/**
 * The unified phase-based content ladder shared by article / trending / bilibili:
 * streaming+streamText → Streamdown; streaming+no text → AnalyzingPlaceholder;
 * done → doneMarkdown? + resultCard; error → AnalysisErrorBlock; idle → empty.
 */
export function AnalysisContent({
  phase,
  streamText,
  error,
  isPending,
  resultCard,
  doneMarkdown,
  analyzingLabel,
  emptyPrompt,
  className,
}: AnalysisContentProps): React.JSX.Element {
  if (phase === 'streaming' || isPending) {
    if (streamText) {
      return (
        <div className={cn('text-[13px] text-foreground/85 leading-relaxed', className)}>
          <Streamdown>{streamText}</Streamdown>
        </div>
      )
    }
    return <AnalyzingPlaceholder label={analyzingLabel} />
  }
  if (phase === 'done' && resultCard) {
    return (
      <div className="flex flex-col gap-3.5">
        {doneMarkdown ? (
          <div className="text-[13px] text-foreground/85 leading-relaxed">
            <Streamdown>{doneMarkdown}</Streamdown>
          </div>
        ) : null}
        {resultCard}
      </div>
    )
  }
  if (phase === 'error' && error) {
    return <AnalysisErrorBlock error={error} />
  }
  return <AnalysisEmptyState prompt={emptyPrompt} />
}
