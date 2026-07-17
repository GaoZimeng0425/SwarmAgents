import { createPrimitives } from './primitives'
import type { WorkflowCtx, WorkflowDeps } from './types'

/**
 * Run a code-defined workflow. The topology — who runs when, how results flow —
 * lives entirely in `workflow` as ordinary JS. We only inject the agentFn and
 * assemble the primitives; orchestration itself stays deterministic and
 * inspectable (debugger, console.log, breakpoints all work).
 *
 * @param name    human label, for logging only
 * @param workflow your topology, written against WorkflowCtx
 * @param deps    the injected execution layer (AgentFn + optional defaults)
 */
export async function runWorkflow<T>(
  name: string,
  workflow: (ctx: WorkflowCtx) => Promise<T>,
  deps: WorkflowDeps
): Promise<T> {
  const startedAt = Date.now()
  const ctx = createPrimitives(deps.agentFn, deps.concurrency ?? 4)
  try {
    const result = await workflow(ctx)
    return result
  } finally {
    // Kept dependency-free: no pino import here, so this package stays zero-dep.
    // Integration code can wrap runWorkflow to add structured logging if wanted.
    const elapsed = Date.now() - startedAt
    // eslint-disable-next-line no-console
    console.debug(`[orchestrator] workflow "${name}" finished in ${elapsed}ms`)
  }
}
