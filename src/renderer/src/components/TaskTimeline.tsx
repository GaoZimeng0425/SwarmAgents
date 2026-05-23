import type { UIEvent } from '../../../shared/types/ui'

type Props = { events: UIEvent[] }

const fmtTime = (ts: number): string => {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function eventLabel(e: UIEvent): string {
  switch (e.kind) {
    case 'task.created':
      return 'created'
    case 'task.dispatched':
      return `dispatched → ${e.workerId.slice(0, 10)}…`
    case 'task.progress':
      return `${e.event.kind}`
    case 'task.tool_call':
      return `tool.call ${e.tool}`
    case 'task.permission_request':
      return `permission requested (${e.risk}): ${e.summary}`
    case 'task.complete':
      return 'completed'
    case 'task.error':
      return 'error'
  }
}

function eventDetail(e: UIEvent): string | null {
  if (e.kind === 'task.progress') {
    const ev = e.event
    if (ev.kind === 'llm.message') {
      return typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content)
    }
    if (ev.kind === 'tool.call') {
      return `${ev.server}.${ev.tool}(${JSON.stringify(ev.args)})`
    }
    if (ev.kind === 'tool.result') {
      return JSON.stringify(ev.payload)
    }
    return JSON.stringify(ev)
  }
  if (e.kind === 'task.tool_call') {
    return JSON.stringify(e.args)
  }
  if (e.kind === 'task.complete') {
    return e.summary
  }
  if (e.kind === 'task.error') {
    const err = e.error as { message?: string; code?: string }
    return err?.message ?? JSON.stringify(e.error)
  }
  return null
}

function eventColor(e: UIEvent): string {
  switch (e.kind) {
    case 'task.created':
    case 'task.dispatched':
      return 'text-white/40'
    case 'task.progress':
      if (e.event.kind === 'llm.message') return 'text-white/90'
      if (e.event.kind === 'tool.call') return 'text-amber-300'
      if (e.event.kind === 'tool.result') return 'text-emerald-300'
      return 'text-white/60'
    case 'task.tool_call':
      return 'text-amber-300'
    case 'task.permission_request':
      return 'text-amber-400'
    case 'task.complete':
      return 'text-emerald-400'
    case 'task.error':
      return 'text-rose-400'
  }
}

export default function TaskTimeline({ events }: Props): React.JSX.Element {
  if (events.length === 0) {
    return <div className="p-3 text-xs text-white/30">No events yet.</div>
  }
  return (
    <ol className="space-y-2 p-3">
      {events.map((e, i) => {
        const detail = eventDetail(e)
        return (
          <li key={i} className="flex gap-3 text-xs leading-relaxed">
            <span className="mono shrink-0 text-white/30">{fmtTime(e.ts)}</span>
            <div className="min-w-0 flex-1">
              <div className={`mono ${eventColor(e)}`}>{eventLabel(e)}</div>
              {detail ? (
                <div className="selectable mono mt-0.5 break-words whitespace-pre-wrap text-white/60">
                  {detail}
                </div>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
