// @swarm/orchestrator — deterministic, code-defined multi-agent orchestration.
// Zero runtime deps. Inject an AgentFn; write topologies as plain JS.

export { pool } from './pool'
export { createPrimitives } from './primitives'
export { runWorkflow } from './runner'
export type {
  AgentFn,
  AgentOpts,
  AgentResult,
  WorkflowCtx,
  WorkflowDeps,
} from './types'
