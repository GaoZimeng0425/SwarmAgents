import { Check, Loader2 } from 'lucide-react'

// Maps the transcription queue's progress stages to a 3-step indicator:
// 下载音频 (audio) -> 解析音频 (transcribing) -> AI 分析 (summarizing). The active
// step spins; earlier steps show a check; later steps are dimmed. 'queued'/null
// leave every step pending.
const STEPS = [
  { key: 'audio', label: '下载音频' },
  { key: 'transcribing', label: '解析音频' },
  { key: 'summarizing', label: 'AI 分析' },
] as const

type StepState = 'done' | 'active' | 'pending'

export function TranscribeProgress({ stage }: { stage: string | null }): React.JSX.Element {
  const activeIdx = STEPS.findIndex((s) => s.key === stage)

  const stateFor = (idx: number): StepState => {
    if (activeIdx < 0) return 'pending'
    if (idx < activeIdx) return 'done'
    if (idx === activeIdx) return 'active'
    return 'pending'
  }

  return (
    <div className="flex flex-col gap-2">
      {STEPS.map((step, idx) => {
        const state = stateFor(idx)
        return (
          <div
            className="flex items-center gap-2 text-sm"
            data-state={state}
            data-testid={`step-${step.key}`}
            key={step.key}
          >
            {state === 'done' ? (
              <Check className="size-4 text-primary" />
            ) : state === 'active' ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            )}
            <span className={state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>{step.label}</span>
          </div>
        )
      })}
    </div>
  )
}
