import { pool } from './pool'
import type { AgentFn, AgentOpts, AgentResult, WorkflowCtx } from './types'

/**
 * Build the three WorkflowCtx primitives on top of an injected AgentFn.
 * Each is a thin convenience — you could call agentFn + Promise.all by hand,
 * these just make topologies read at a glance.
 */
export function createPrimitives(agentFn: AgentFn, defaultConcurrency: number): WorkflowCtx {
  const agent = (prompt: string, opts?: AgentOpts): Promise<AgentResult> => agentFn(prompt, opts)

  const pipeline: WorkflowCtx['pipeline'] = (items, fn, opts) => {
    const concurrency = opts?.concurrency ?? defaultConcurrency
    return pool(items, concurrency, fn)
  }

  const converge: WorkflowCtx['converge'] = (calls) => Promise.all(calls.map((c) => c()))

  return { agent, pipeline, converge }
}
