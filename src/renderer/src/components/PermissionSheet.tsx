import type { PermissionDecision } from '../../../shared/types/ui'
import type { Risk } from '../../../shared/types/ipc'

export type PermissionPrompt = {
  actionId: string
  taskId: string
  workerId: string
  risk: Risk
  summary: string
  payload: unknown
}

type Props = {
  prompt: PermissionPrompt | null
  onDecide: (actionId: string, decision: PermissionDecision) => void
}

const riskColor: Record<Risk, string> = {
  low: 'text-emerald-300',
  medium: 'text-amber-300',
  high: 'text-rose-300',
}

export default function PermissionSheet({ prompt, onDecide }: Props): React.JSX.Element | null {
  if (!prompt) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-md rounded-t-xl border border-white/10 bg-neutral-900 p-5 shadow-2xl sm:rounded-xl">
        <div className="mb-3 flex items-center gap-2">
          <span className={`mono text-xs uppercase ${riskColor[prompt.risk]}`}>
            {prompt.risk} risk
          </span>
          <span className="text-sm text-white/60">Confirm action</span>
        </div>
        <div className="selectable mb-4 text-base text-white">{prompt.summary}</div>
        {prompt.payload ? (
          <pre className="selectable mono mb-4 max-h-40 overflow-auto rounded-md bg-white/5 p-2 text-xs text-white/60">
            {JSON.stringify(prompt.payload, null, 2)}
          </pre>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDecide(prompt.actionId, 'skip')}
            className="rounded-md px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => onDecide(prompt.actionId, 'deny')}
            className="rounded-md bg-rose-500/20 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/30"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onDecide(prompt.actionId, 'grant')}
            className="rounded-md bg-emerald-500/30 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/40"
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  )
}
