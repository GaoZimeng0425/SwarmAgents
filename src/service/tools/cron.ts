import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'

import type { CronScheduler } from '../cron-scheduler'
import type { ToolRunContext, ToolSpec } from './registry'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const ScheduleParams = Type.Object({
  cron: Type.String({
    description: 'Standard 5- or 6-field cron expression, e.g. "0 9 * * *" for 9am daily.',
  }),
  goal: Type.String({ description: 'The goal to run on each fire, as if typed into this session.' }),
  name: Type.Optional(Type.String({ description: 'Optional human-readable label for the job.' })),
})

const CancelParams = Type.Object({
  id: Type.String({ description: 'Id of the scheduled task to cancel (from list_scheduled_tasks).' }),
})

const DEFAULT_RUNS_LIMIT = 20
const MAX_RUNS_LIMIT = 100

const RunsParams = Type.Object({
  id: Type.String({ description: 'Id of the scheduled task to inspect (from list_scheduled_tasks).' }),
  limit: Type.Optional(
    Type.Number({ description: `Max runs to return, newest first (default ${DEFAULT_RUNS_LIMIT}, max ${MAX_RUNS_LIMIT}).` })
  ),
})

function scheduleTool(scheduler: CronScheduler, ctx: ToolRunContext): AgentTool {
  return {
    name: 'schedule_task',
    label: 'Schedule task',
    description:
      'Schedule a goal to run automatically on a recurring cron schedule in this session. Returns the job id and next run time. Use list_scheduled_tasks/cancel_scheduled_task to manage jobs.',
    parameters: ScheduleParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { cron: string; goal: string; name?: string }
      if (!p.cron) return err('cron is required')
      if (!p.goal) return err('goal is required')
      try {
        const { id, nextRun } = scheduler.add({
          sessionId: ctx.sessionId,
          cron: p.cron,
          goal: p.goal,
          name: p.name,
        })
        return ok(
          `scheduled "${p.name ?? p.goal.slice(0, 40)}" (id ${id}); next run ${new Date(nextRun).toISOString()}`,
          {
            id,
            nextRun,
          }
        )
      } catch (e) {
        return err(`invalid cron expression "${p.cron}": ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

// Render a job's most recent run as a compact status segment. Failed/error
// runs append a truncated error so the cause is visible without a follow-up.
function formatLastRun(run: ReturnType<CronScheduler['latestRunForJob']>): string {
  if (!run) return 'last never'
  const when = new Date(run.triggeredAt).toISOString()
  if (run.error) {
    const e = run.error.length > 60 ? `${run.error.slice(0, 57)}...` : run.error
    return `last ${run.status} @ ${when} (${e})`
  }
  return `last ${run.status} @ ${when}`
}

function listTool(scheduler: CronScheduler, ctx: ToolRunContext): AgentTool {
  return {
    name: 'list_scheduled_tasks',
    label: 'List scheduled tasks',
    description: 'List the scheduled (cron) tasks for this session, each with its most recent execution status.',
    parameters: Type.Object({}),
    execute: async () => {
      const jobs = scheduler.listForSession(ctx.sessionId)
      if (jobs.length === 0) return ok('no scheduled tasks', { count: 0 })
      const detailJobs: Array<{ id: string; lastRun: ReturnType<CronScheduler['latestRunForJob']> }> = []
      const lines = jobs.map((j) => {
        const lastRun = scheduler.latestRunForJob(j.id)
        detailJobs.push({ id: j.id, lastRun })
        const next = j.nextRun ? new Date(j.nextRun).toISOString() : 'n/a'
        return `- [${j.id}] ${j.name ?? '(unnamed)'} | ${j.cron} | next ${next} | ${formatLastRun(lastRun)} | ${j.goal}`
      })
      return ok(lines.join('\n'), { count: jobs.length, jobs: detailJobs })
    },
  }
}

function cancelTool(scheduler: CronScheduler): AgentTool {
  return {
    name: 'cancel_scheduled_task',
    label: 'Cancel scheduled task',
    description: 'Cancel and remove a scheduled task by its id.',
    parameters: CancelParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { id: string }
      if (!p.id) return err('id is required')
      const existed = scheduler.remove(p.id)
      return ok(existed ? `cancelled ${p.id}` : `no scheduled task ${p.id}`, { removed: existed, id: p.id })
    },
  }
}

// Render one run record as a history line: when it fired, its outcome, how
// long it took (or 'running' if unfinished), the produced task, and any error.
function formatRun(run: ReturnType<CronScheduler['runsForJob']>[number]): string {
  const when = new Date(run.triggeredAt).toISOString()
  const took = run.endedAt != null ? `${run.endedAt - run.triggeredAt}ms` : 'running'
  const task = run.taskId ?? '—'
  const errSeg = run.error ? ` | ${run.error.length > 80 ? `${run.error.slice(0, 77)}...` : run.error}` : ''
  return `- [${when}] ${run.status} | ${took} | task ${task}${errSeg}`
}

function runsTool(scheduler: CronScheduler): AgentTool {
  return {
    name: 'list_task_runs',
    label: 'List task runs',
    description:
      'List the execution history (past runs) of one scheduled task by its id, newest first. Each run shows its outcome, duration, the task it produced, and any error.',
    parameters: RunsParams,
    execute: async (_id: string, params: unknown) => {
      const p = params as { id?: string; limit?: number }
      if (!p.id) return err('id is required')
      const limit = Math.min(Math.max(Math.trunc(p.limit ?? DEFAULT_RUNS_LIMIT), 1), MAX_RUNS_LIMIT)
      const runs = scheduler.runsForJob(p.id).slice(0, limit)
      if (runs.length === 0) return ok(`no runs recorded for ${p.id}`, { id: p.id, count: 0, runs: [] })
      return ok(runs.map(formatRun).join('\n'), { id: p.id, count: runs.length, runs })
    },
  }
}

// schedule_task is medium risk: it arms future autonomous agent runs, so it
// goes through the central permission prompt (cf. spawn_sub_agent). list,
// list_task_runs, and cancel are low risk — read/cleanup of internal bookkeeping.
export function cronSpecs(scheduler: CronScheduler): ToolSpec[] {
  return [
    {
      group: 'cron',
      name: 'schedule_task',
      risk: 'medium' as const,
      source: 'builtin' as const,
      build: (ctx) => scheduleTool(scheduler, ctx),
    },
    {
      group: 'cron',
      name: 'list_scheduled_tasks',
      risk: 'low' as const,
      source: 'builtin' as const,
      build: (ctx) => listTool(scheduler, ctx),
    },
    {
      group: 'cron',
      name: 'list_task_runs',
      risk: 'low' as const,
      source: 'builtin' as const,
      build: () => runsTool(scheduler),
    },
    {
      group: 'cron',
      name: 'cancel_scheduled_task',
      risk: 'low' as const,
      source: 'builtin' as const,
      build: () => cancelTool(scheduler),
    },
  ]
}
