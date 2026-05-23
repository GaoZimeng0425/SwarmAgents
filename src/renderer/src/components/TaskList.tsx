import { useState } from 'react'

import type { UIEvent } from '../../../shared/types/ui'

import TaskTimeline from './TaskTimeline'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_user'

export type TaskRecord = {
  id: string
  goal: string
  status: TaskStatus
  workerId: string | null
  summary: string | null
  startedAt: number
  events: UIEvent[]
}

const statusBadge: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: 'pending', cls: 'bg-white/10 text-white/60' },
  running: { label: 'running', cls: 'bg-sky-500/20 text-sky-300' },
  awaiting_user: { label: 'awaiting you', cls: 'bg-amber-400/20 text-amber-300' },
  completed: { label: 'done', cls: 'bg-emerald-500/20 text-emerald-300' },
  failed: { label: 'failed', cls: 'bg-rose-500/20 text-rose-300' },
}

function TaskRow({ task }: { task: TaskRecord }): React.JSX.Element {
  const [open, setOpen] = useState(task.status === 'running' || task.status === 'awaiting_user')
  const badge = statusBadge[task.status]

  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/5"
      >
        <span
          className={`mono shrink-0 rounded-md px-1.5 py-0.5 text-[10px] uppercase ${badge.cls}`}
        >
          {badge.label}
        </span>
        <span className="selectable min-w-0 flex-1 truncate text-sm text-white/90">
          {task.goal}
        </span>
        <span className="mono shrink-0 text-[11px] text-white/30">
          {task.events.length} evt{task.events.length === 1 ? '' : 's'}
        </span>
        <span className="mono shrink-0 text-[10px] text-white/30">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="border-t border-white/5">
          {task.summary ? (
            <div className="px-3 py-2 text-sm text-emerald-300/90">{task.summary}</div>
          ) : null}
          <TaskTimeline events={task.events} />
        </div>
      ) : null}
    </li>
  )
}

type Props = { tasks: TaskRecord[] }

export default function TaskList({ tasks }: Props): React.JSX.Element {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-white/30">
        Submit a goal above and the swarm will pick it up.
      </div>
    )
  }
  return (
    <ul className="flex-1 space-y-2 overflow-y-auto p-4">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </ul>
  )
}
