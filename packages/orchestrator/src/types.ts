// @swarm/orchestrator — deterministic, code-defined multi-agent orchestration.
// Zero runtime deps. The only coupling to an execution layer is AgentFn.

/** Outcome of a single agent invocation. */
export type AgentResult = {
  /** The agent's textual output (summary, answer, etc.). */
  text: string
  /** Whether the run succeeded. false ⇒ error is set. */
  ok: boolean
  /** Populated when ok === false. */
  error?: string
}

/** Optional knobs passed through to the underlying agent. */
export type AgentOpts = {
  agentType?: string
  tools?: string[]
  /** Free-form tags for logging/correlation. */
  tags?: Record<string, unknown>
}

/**
 * The single seam between orchestration and execution.
 * Prototype: a mock returning canned results.
 * Integration: a thin wrapper over launchMessage.
 */
export type AgentFn = (prompt: string, opts?: AgentOpts) => Promise<AgentResult>

/**
 * What a workflow function receives. Your topology lives in how you combine
 * these three primitives — the results are plain JS values, never silently
 * stuffed into any agent's context window.
 */
export type WorkflowCtx = {
  /** Run a single agent. The atomic unit. */
  agent: (prompt: string, opts?: AgentOpts) => Promise<AgentResult>
  /**
   * Fan-out over a list, map each item through an agent call, cap concurrency.
   * Results are returned in input order (not completion order). The "map" half
   * of map-reduce.
   */
  pipeline: <T>(
    items: T[],
    fn: (item: T, index: number) => Promise<AgentResult>,
    opts?: { concurrency?: number }
  ) => Promise<AgentResult[]>
  /**
   * Run a batch of thunks fully in parallel, resolve only when all finish.
   * The "reduce" half of map-reduce — gather independent results to converge on.
   */
  converge: (calls: Array<() => Promise<AgentResult>>) => Promise<AgentResult[]>
}

/** Dependencies injected into runWorkflow. */
export type WorkflowDeps = {
  /** The agent execution function. Required. */
  agentFn: AgentFn
  /** Default concurrency cap for pipeline when its own opts omit it. */
  concurrency?: number
}
