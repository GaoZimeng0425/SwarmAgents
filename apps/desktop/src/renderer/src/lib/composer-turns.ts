import type { RunRecord } from '@shared/lib/apply-event'
import { sortBy } from 'es-toolkit'

export type ComposerTurns = {
  /**
   * The in-flight turn driving the composer's stop control: the running /
   * awaiting_user turn, or — when nothing is running yet — the earliest pending
   * turn that is about to be dispatched.
   */
  activeTask: RunRecord | undefined
  /** Turns genuinely waiting behind the active turn, FIFO (oldest first). */
  queuedTasks: RunRecord[]
  /**
   * Tasks belonging in the conversation transcript: every session task except
   * the queued ones, which are staged as pending cards in the composer and not
   * yet part of the conversation. Keeps a message submitted mid-run out of the
   * message list (it shows only in the pending list until it starts).
   */
  transcriptTasks: RunRecord[]
}

/**
 * Split a session's turns into the active (in-flight) turn and the queued turns
 * rendered as staging cards above the composer.
 *
 * A submitted turn is 'pending' from task.created until the separate
 * task.dispatched event flips it to 'running'; the DB also keeps a running turn
 * at 'pending' until it ends, so hydrateSession re-injects a pending record on
 * every navigation. The active turn is therefore briefly 'pending' too, and
 * classifying every pending turn as queued flashes the just-submitted message as
 * a staging card. So when nothing is running, the earliest pending turn is the
 * active (about-to-start) turn — not a queued one. Only top-level turns count;
 * sub-agent children belong in the transcript, not the composer queue.
 */
export function classifyComposerTurns(
  sessionTasks: RunRecord[],
  // Mirrors SessionSummary['status']. A non-active (interrupted/ended) session
  // can't resume any turn, so its pending turns are stale zombies — render them
  // in the transcript instead of as phantom queued cards.
  sessionStatus: 'active' | 'interrupted' | 'ended' = 'active'
): ComposerTurns {
  if (sessionStatus !== 'active') {
    return { activeTask: undefined, queuedTasks: [], transcriptTasks: sessionTasks }
  }
  const topLevel = sessionTasks.filter((t) => !t.parentRunId)
  const running = topLevel.find((t) => t.status === 'running' || t.status === 'awaiting_user')
  const pending = sortBy(
    topLevel.filter((t) => t.status === 'pending'),
    ['startedAt']
  )
  const startingTask = running ? undefined : pending[0]
  const queuedTasks = startingTask ? pending.slice(1) : pending
  const queuedIds = new Set(queuedTasks.map((t) => t.id))
  return {
    activeTask: running ?? startingTask,
    queuedTasks,
    transcriptTasks: sessionTasks.filter((t) => !queuedIds.has(t.id)),
  }
}
