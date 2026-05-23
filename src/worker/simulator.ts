import type { Outbound } from '@shared/types/ipc'
import type { Task, TaskEvent } from '@shared/types/task'

import type { SendFn } from './handler'

/**
 * Simulated agent loop for the foundation MVP — no LLM, no MCP yet.
 *
 * Emits a deterministic, observable sequence of TaskEvents that mimic what a
 * real worker loop will look like: a few `llm.message` steps, one `tool.call`
 * (without a real MCP behind it), a `tool.result` echo, and finally a
 * `task.complete`. Replaced by the real Vercel AI SDK loop in Phase B and the
 * Peekaboo MCP wiring in Phase C.
 */
export type SimulatorOptions = {
  /** Milliseconds between emitted steps. Override to 0/1 for tests. */
  stepMs?: number
}

export async function simulateThinking(
  task: Task,
  send: SendFn,
  opts: SimulatorOptions = {},
): Promise<void> {
  const stepMs = opts.stepMs ?? 600
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const progress = (event: TaskEvent): void => {
    const msg: Outbound = { type: 'progress', event }
    send(msg)
  }

  // Step 1 — acknowledge.
  await wait(stepMs)
  progress({
    kind: 'llm.message',
    role: 'assistant',
    content: `Got it. Goal received: "${task.goal}". Planning approach…`,
    ts: Date.now(),
  })

  // Step 2 — pretend to break the goal into actions.
  await wait(stepMs)
  progress({
    kind: 'llm.message',
    role: 'assistant',
    content:
      'I would normally call see/click/type tools here. Demoing the tool-call path with a no-op see action.',
    ts: Date.now(),
  })

  // Step 3 — call a (fake) tool, immediately self-resolve.
  await wait(stepMs)
  progress({
    kind: 'tool.call',
    server: 'peekaboo',
    tool: 'see',
    args: { mode: 'screen' },
    ts: Date.now(),
  })

  await wait(Math.max(100, Math.floor(stepMs / 2)))
  progress({
    kind: 'tool.result',
    ok: true,
    payload: { kind: 'text', text: '(simulator) screen captured — no real MCP yet' },
    ts: Date.now(),
  })

  // Step 4 — concluding thought.
  await wait(stepMs)
  progress({
    kind: 'llm.message',
    role: 'assistant',
    content: 'Done. Wrapping up the task.',
    ts: Date.now(),
  })

  // Step 5 — completion.
  await wait(Math.max(100, Math.floor(stepMs / 2)))
  send({
    type: 'task.complete',
    taskId: task.id,
    result: {
      summary: `Simulated completion for goal: "${task.goal}"`,
      artifacts: [],
    },
  })
}
