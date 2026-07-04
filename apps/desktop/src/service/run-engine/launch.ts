import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  Attachment,
  ConsumedResources,
  DelegationItem,
  PermissionMode,
  ProviderInjection,
  ResourceBudget,
} from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
import { ulid } from 'ulid'

import type { PermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry, ToolRunContext } from '../tools/registry'
import { createRunEmit, type RunEmit, type RunEmitPorts } from './emit'
import { createEngine, type EngineRunResult, EngineSetupError } from './engine'
import { injectionSupportsImages } from './models'

const log = createLogger({ process: 'service' }).child({ component: 'run-launch' })

export type RunKind = 'turn' | 'work' | 'child'

export type DelegateResult = { runId: string; status: 'completed' | 'failed' | 'cancelled'; summary: string }

export type RunSpec = {
  kind: RunKind
  /** Minted when absent. */
  runId?: string
  sessionId: string
  agent: AgentDefinition
  provider: ProviderInjection
  fallbackProviders?: ProviderInjection[]
  /** The user-facing goal; also the run.created goal. */
  prompt: string
  /** Prior context ONLY — never contains the prompt (spec D4). */
  history?: AgentMessage[]
  attachments?: Attachment[]
  budget: ResourceBudget
  parentRunId?: string
  /** Tool allowlist; empty resolves the agent's defaults per registry semantics. */
  tools?: string[]
  cwd?: string
  executionMode?: 'goal' | 'plan'
  permissionMode?: PermissionMode
  getPermissionMode?: () => PermissionMode
  saveSnapshot?: (messages: AgentMessage[], used: ConsumedResources, contextWindow?: number) => void
  maxIterationsOverride?: number
  retry?: { maxRetries?: number; delayMs?: number }
  onDelegationPlan?: (plan: DelegationItem[]) => void
}

export type LaunchPorts = {
  emit: RunEmitPorts
  toolRegistry: ToolRegistry
  permissionRegistry: PermissionRegistry
  /** Per-session FIFO ticket for 'turn' runs; resolves when the run may execute. */
  waitTurn?: (sessionId: string, runId: string, signal: AbortSignal) => Promise<void>
  /** Global concurrency pool; resolves with the release fn. */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  registerAbort: (runId: string, abort: () => void) => void
  unregisterAbort: (runId: string) => void
  /** Recursive child launch (SessionService binds this in W3 to a nested launchRun). */
  delegate?: (
    parentRunId: string,
    goal: string,
    opts: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ) => Promise<DelegateResult>
  writeAgent?: ToolRunContext['writeAgent']
  writeSkill?: ToolRunContext['writeSkill']
  findAgents?: ToolRunContext['findPeers']
}

/** System prompt for the one-shot vision/OCR sub-run (v1 parity). */
const VISION_SYSTEM_PROMPT =
  'You are a vision and OCR assistant. Look at the provided image and answer the request precisely. For OCR, return only the extracted text, preserving line breaks. Do not add commentary.'

const SILENT_EMIT_PORTS: RunEmitPorts = {
  nextSeq: () => 0,
  appendEvent: () => undefined,
  markTerminal: () => undefined,
  broadcast: () => undefined,
}

const cancelledResult = (runId: string, history: AgentMessage[]): EngineRunResult & { runId: string } => ({
  runId,
  status: 'cancelled',
  summary: '',
  messages: history,
  used: emptyUsed(),
})

/**
 * The ONE way any run starts (spec §3). Owns: id mint, run.created/dispatched,
 * abort-before-waits (ledger #4), slot acquisition + delegate slot-yield
 * (ledger #5), uniform tool-context assembly (ledger #11/#12), engine
 * invocation, setup-failure terminals, cleanup. Never rejects.
 */
export async function launchRun(spec: RunSpec, ports: LaunchPorts): Promise<EngineRunResult & { runId: string }> {
  const runId = spec.runId ?? ulid()
  const emit: RunEmit = createRunEmit(ports.emit, {
    sessionId: spec.sessionId,
    runId,
    ...(spec.parentRunId !== undefined ? { parentRunId: spec.parentRunId } : {}),
  })
  const runLog = log.child({ runId, sessionId: spec.sessionId })
  const ac = new AbortController()
  // Register BEFORE any wait: a cancel issued while queued must find the handle
  // (v1's spawnChild registered after the slot — the exact race, ledger #4).
  ports.registerAbort(runId, () => ac.abort())
  emit({
    kind: 'run.created',
    goal: spec.prompt,
    ...(spec.attachments?.length ? { attachments: spec.attachments } : {}),
    ...(spec.kind === 'child' ? { agentDefId: spec.agent.id } : {}),
  })
  runLog.info({ msg: 'run created', kind: spec.kind, agentId: spec.agent.id, promptLen: spec.prompt.length })

  let release: (() => void) | null = null
  // Depth-counted so parallel delegate tool calls don't double-release/acquire.
  let yieldDepth = 0
  const withSlotReleased = async <T>(fn: () => Promise<T>): Promise<T> => {
    yieldDepth++
    if (yieldDepth === 1 && release) {
      release()
      release = null
    }
    try {
      return await fn()
    } finally {
      yieldDepth--
      if (yieldDepth === 0 && !ac.signal.aborted) release = await ports.acquireSlot(ac.signal)
    }
  }

  const emitCancelled = (): void => {
    emit({ kind: 'run.error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' } })
    runLog.info({ msg: 'run cancelled before dispatch' })
  }

  try {
    if (spec.kind === 'turn' && ports.waitTurn) {
      await Promise.race([
        ports.waitTurn(spec.sessionId, runId, ac.signal),
        new Promise<void>((resolve) => {
          if (ac.signal.aborted) resolve()
          else ac.signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
    }
    if (ac.signal.aborted) {
      emitCancelled()
      return cancelledResult(runId, spec.history ?? [])
    }
    release = await ports.acquireSlot(ac.signal)
    if (ac.signal.aborted) {
      emitCancelled()
      return cancelledResult(runId, spec.history ?? [])
    }
    emit({ kind: 'run.dispatched' })
    runLog.info({ msg: 'run dispatched', kind: spec.kind })

    // Uniform tool context — identical for every kind (ledger #11/#12).
    const usageSink = { charge: (_costUsd: number): void => undefined }
    const ctx: ToolRunContext = {
      sessionId: spec.sessionId,
      taskId: runId,
      cwd: spec.cwd,
      spawnChild: (goal, suggestedTools, providerKey, agentType) => {
        if (!ports.delegate) return Promise.reject(new Error('delegate is not available in this run'))
        return withSlotReleased(() => ports.delegate!(runId, goal, { suggestedTools, providerKey, agentType })).then(
          (r) => ({
            childTaskId: r.runId,
            result: { summary: r.summary, artifacts: [] },
          })
        )
      },
      send: () => undefined,
      // Tools must NOT self-gate: permission is enforced centrally in the engine.
      requestPermission: () => Promise.resolve('grant' as const),
      // No silent fake success (v1 optional-chained to a no-op and reported
      // delivery — ledger #11). The messaging tools are deleted in W3; until
      // then a call fails loudly.
      sendMessage: () => Promise.reject(new Error('messaging is not available in this run')),
      sendAndWait: () => Promise.reject(new Error('messaging is not available in this run')),
      findPeers: (q) => ports.findAgents?.(q) ?? [],
      writeAgent: ports.writeAgent,
      writeSkill: ports.writeSkill,
      setDelegationPlan: (plan) => {
        emit({ kind: 'run.delegation_plan', plan })
        spec.onDelegationPlan?.(plan)
      },
      reportExternalUsage: (usage) => {
        if (usage.costUsd && usage.costUsd > 0) usageSink.charge(usage.costUsd)
      },
      analyzeImage: buildAnalyzeImage(spec, ports, runId, ac.signal),
    }
    const { tools, riskOf } = ports.toolRegistry.resolve(spec.tools ?? [], ctx)
    if (tools.length === 0) runLog.warn({ msg: 'no tools resolved for run', toolAllowlist: spec.tools ?? [] })

    const engine = createEngine({
      runId,
      sessionId: spec.sessionId,
      agentDefinition: spec.agent,
      provider: spec.provider,
      fallbackProviders: spec.fallbackProviders,
      history: spec.history ?? [],
      budget: spec.budget,
      cwd: spec.cwd,
      executionMode: spec.executionMode,
      permissionMode: spec.permissionMode,
      getPermissionMode: spec.getPermissionMode,
      tools,
      riskOf,
      emit,
      permissionRegistry: ports.permissionRegistry,
      signal: ac.signal,
      saveSnapshot: spec.saveSnapshot,
      maxIterationsOverride: spec.maxIterationsOverride,
      retry: spec.retry,
    })
    usageSink.charge = (costUsd) => engine.chargeExternalUsd(costUsd)

    const images = (spec.attachments ?? []).map((a) => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }))
    const r = await engine.run(spec.prompt, images.length > 0 ? images : undefined)
    runLog.info({ msg: 'run finished', status: r.status, summaryLen: r.summary.length })
    return { runId, ...r }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof EngineSetupError ? 'agent_setup_failed' : 'agent_exception'
    runLog.error({ msg: 'run launch failed', code, err: message })
    emit({ kind: 'run.error', error: { code, message, tier: 'fatal' } })
    return { runId, status: 'failed', summary: '', messages: spec.history ?? [], used: emptyUsed() }
  } finally {
    release?.()
    ports.unregisterAbort(runId)
  }
}

/**
 * Vision capability for the tool context: first image-capable model in the
 * chain, driven through a SILENT nested launch (no events reach the parent's
 * sink; the visible analyze_image tool.call/result already represents it).
 * The nested run shares the parent's cancellation and rides the parent's slot.
 */
function buildAnalyzeImage(
  spec: RunSpec,
  ports: LaunchPorts,
  parentRunId: string,
  parentSignal: AbortSignal
): ToolRunContext['analyzeImage'] {
  const chain = [spec.provider, ...(spec.fallbackProviders ?? spec.provider.fallbackProviders ?? [])].filter(
    (p): p is ProviderInjection => !!p
  )
  const vision = chain.find(injectionSupportsImages)
  if (!vision) return undefined
  return async (prompt, image) => {
    const r = await launchRun(
      {
        kind: 'work',
        runId: `${parentRunId}:vision:${ulid()}`,
        sessionId: spec.sessionId,
        agent: {
          id: 'vision',
          name: 'Vision',
          description: 'One-shot vision/OCR sub-run.',
          systemPrompt: VISION_SYSTEM_PROMPT,
          toolScope: 'all',
          maxIterations: 2,
        } as AgentDefinition,
        provider: vision,
        prompt,
        attachments: [{ data: image.data, mimeType: image.mimeType }],
        budget: spec.budget,
        tools: [],
        permissionMode: spec.permissionMode,
        maxIterationsOverride: 2,
      },
      {
        ...ports,
        emit: SILENT_EMIT_PORTS,
        waitTurn: undefined,
        delegate: undefined,
        // Rides the parent's slot: the nested run must not compete for the pool
        // while its parent already holds a slot (that's the ledger-#5 shape).
        acquireSlot: async () => () => undefined,
        registerAbort: (_id, abort) => {
          if (parentSignal.aborted) abort()
          else parentSignal.addEventListener('abort', abort, { once: true })
        },
        unregisterAbort: () => undefined,
      }
    )
    return r.summary
  }
}
