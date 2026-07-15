import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createLogger } from '@shared/logger'
import type {
  AgentDefinition,
  Artifact,
  Attachment,
  ConsumedResources,
  DelegateResult,
  DelegationItem,
  DelegationItemStatus,
  PermissionMode,
  ProviderInjection,
  ResourceBudget,
} from '@swarm/protocol'
import { emptyUsed } from '@swarm/protocol'
import { ulid } from 'ulid'

import type { PermissionRegistry } from '../session/permission-registry'
import type { ToolRegistry, ToolRunContext } from '../tools/registry'
import { reportResultSpec } from '../tools/report-result'
import { createMessageEmit, type MessageEmit, type MessageEmitPorts } from './emit'
import { createEngine, type EngineRunResult, EngineSetupError } from './engine'
import { injectionSupportsImages } from './models'

const log = createLogger({ process: 'service' }).child({ component: 'message-launch' })

type MessageKind = 'turn' | 'work' | 'child'

export type MessageSpec = {
  kind: MessageKind
  /** Minted when absent. */
  messageId?: string
  sessionId: string
  agent: AgentDefinition
  provider: ProviderInjection
  fallbackProviders?: ProviderInjection[]
  /** The user-facing prompt text; also the message.created prompt. */
  prompt: string
  /** Prior context ONLY — never contains the prompt (spec D4). */
  history?: AgentMessage[]
  attachments?: Attachment[]
  budget: ResourceBudget
  parentMessageId?: string
  /** Tool allowlist for this run. The CALLER resolves the agent's defaults
   *  (e.g. allowlistForAgent); an empty list resolves NO tools. */
  tools?: string[]
  cwd?: string
  executionMode?: 'direct' | 'plan'
  permissionMode?: PermissionMode
  getPermissionMode?: () => PermissionMode
  saveSnapshot?: (messages: AgentMessage[], used: ConsumedResources, contextWindow?: number) => void
  maxIterationsOverride?: number
  retry?: { maxRetries?: number; delayMs?: number }
  onDelegationPlan?: (plan: DelegationItem[]) => void
  onDelegationUpdate?: (itemId: string, delta: { status: DelegationItemStatus; artifacts: Artifact[] }) => void
}

export type LaunchPorts = {
  emit: MessageEmitPorts
  toolRegistry: ToolRegistry
  permissionRegistry: PermissionRegistry
  /** Per-session FIFO ticket for 'turn' messages; resolves when the message may execute. */
  waitTurn?: (sessionId: string, messageId: string, signal: AbortSignal) => Promise<void>
  /**
   * Global concurrency pool; resolves with the release fn.
   * CONTRACT: once `signal` aborts, the port MUST resolve promptly (a no-op
   * release is fine) — a parked waiter that ignores the signal wedges the
   * message and, in W3, its whole session queue. launchMessage also defends below.
   */
  acquireSlot: (signal: AbortSignal) => Promise<() => void>
  registerAbort: (messageId: string, abort: () => void) => void
  unregisterAbort: (messageId: string) => void
  /** Recursive child launch (SessionService binds this in W3 to a nested launchMessage). */
  delegate?: (
    parentMessageId: string,
    prompt: string,
    opts: { suggestedTools?: string[]; providerKey?: string; agentType?: string }
  ) => Promise<DelegateResult & { messageId: string }>
  /** Agent-authored top-level work message (SessionService binds this to runWork for EVERY message). */
  createTask?: (prompt: string, agentType?: string) => Promise<DelegateResult & { messageId: string }>
  writeAgent?: ToolRunContext['writeAgent']
  writeSkill?: ToolRunContext['writeSkill']
  findAgents?: ToolRunContext['findPeers']
}

/** System prompt for the one-shot vision/OCR sub-run (v1 parity). */
const VISION_SYSTEM_PROMPT =
  'You are a vision and OCR assistant. Look at the provided image and answer the request precisely. For OCR, return only the extracted text, preserving line breaks. Do not add commentary.'

const SILENT_EMIT_PORTS: MessageEmitPorts = {
  nextSeq: () => 0,
  appendEvent: () => undefined,
  markTerminal: () => undefined,
  broadcast: () => undefined,
}

const cancelledResult = (messageId: string, history: AgentMessage[]): EngineRunResult & { messageId: string } => ({
  messageId,
  status: 'cancelled',
  summary: '',
  messages: history,
  used: emptyUsed(),
  artifacts: [],
})

/**
 * The ONE way any message starts (spec §3). Owns: id mint, message.created/dispatched,
 * abort-before-waits (ledger #4), slot acquisition + delegate slot-yield
 * (ledger #5), uniform tool-context assembly (ledger #11/#12), engine
 * invocation, setup-failure terminals, cleanup. Never rejects.
 */
export async function launchMessage(
  spec: MessageSpec,
  ports: LaunchPorts
): Promise<EngineRunResult & { messageId: string }> {
  const messageId = spec.messageId ?? ulid()
  const emit: MessageEmit = createMessageEmit(ports.emit, {
    sessionId: spec.sessionId,
    messageId,
    ...(spec.parentMessageId !== undefined ? { parentMessageId: spec.parentMessageId } : {}),
  })
  const runLog = log.child({ messageId, sessionId: spec.sessionId })
  const ac = new AbortController()
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
      if (yieldDepth === 0 && !ac.signal.aborted) release = await raceAcquire()
    }
  }

  const emitCancelled = (): void => {
    emit({ kind: 'message.error', error: { code: 'cancelled', message: 'Stopped by user.', tier: 'gave_up' } })
    runLog.info({ msg: 'run cancelled before dispatch' })
  }

  // Defense-in-depth for the acquireSlot contract: never stay parked on the
  // pool once the run is cancelled, and hand back a grant that arrives late.
  const raceAcquire = (): Promise<(() => void) | null> =>
    Promise.race([
      ports.acquireSlot(ac.signal).then((release) => {
        if (ac.signal.aborted) {
          release() // late grant after cancel: give it straight back
          return null
        }
        return release
      }),
      new Promise<null>((resolve) => {
        if (ac.signal.aborted) resolve(null)
        else ac.signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
    ])

  try {
    // Register BEFORE any wait: a cancel issued while queued must find the
    // handle (v1's spawnChild registered after the slot — the exact race,
    // ledger #4). Inside the try so a throwing port cannot reject launchMessage.
    ports.registerAbort(messageId, () => ac.abort())
    emit({
      kind: 'message.created',
      ...(spec.attachments?.length ? { attachments: spec.attachments } : {}),
      ...(spec.kind === 'child' ? { agentDefId: spec.agent.id } : {}),
    })
    // The user-facing prompt is a first-class, seq'd message.progress event —
    // the message's input content, symmetric to the assistant's output chunks
    // (also message.progress / role:'assistant'). Emitted here so every kind
    // (turn/work/child) uniformly carries its input on the timeline at the
    // correct causal position (right after created, before dispatch).
    emit({
      kind: 'message.progress',
      event: { kind: 'llm.message', role: 'user', content: spec.prompt, ts: Date.now() },
    })
    runLog.info({ msg: 'run created', kind: spec.kind, agentId: spec.agent.id, promptLen: spec.prompt.length })

    if (spec.kind === 'turn' && ports.waitTurn) {
      await Promise.race([
        ports.waitTurn(spec.sessionId, messageId, ac.signal),
        new Promise<void>((resolve) => {
          if (ac.signal.aborted) resolve()
          else ac.signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
    }
    if (ac.signal.aborted) {
      emitCancelled()
      return cancelledResult(messageId, spec.history ?? [])
    }
    release = await raceAcquire()
    if (ac.signal.aborted || !release) {
      emitCancelled()
      return cancelledResult(messageId, spec.history ?? [])
    }
    emit({ kind: 'message.dispatched' })
    runLog.info({ msg: 'run dispatched', kind: spec.kind })

    // Uniform tool context — identical for every kind (ledger #11/#12).
    const usageSink = { charge: (_costUsd: number): void => undefined }
    const collectedArtifacts: Artifact[] = []
    const ctx: ToolRunContext = {
      sessionId: spec.sessionId,
      taskId: messageId,
      cwd: spec.cwd,
      spawnChild: (prompt, opts) => {
        if (!ports.delegate) return Promise.reject(new Error('delegate is not available in this run'))
        return withSlotReleased(() => ports.delegate!(messageId, prompt, opts ?? {}))
      },
      // Joins spawnChild in yielding the parent slot while it awaits (ledger #5):
      // uniform wiring means delegate topLevel is available on EVERY run,
      // so without this a full pool of parents could wedge on each other.
      createTask: ports.createTask
        ? (prompt, agentType) => withSlotReleased(() => ports.createTask!(prompt, agentType))
        : undefined,
      // Tools must NOT self-gate: permission is enforced centrally in the engine.
      requestPermission: () => Promise.resolve('grant' as const),
      findPeers: (q) => ports.findAgents?.(q) ?? [],
      writeAgent: ports.writeAgent,
      writeSkill: ports.writeSkill,
      setDelegationPlan: (plan) => {
        emit({ kind: 'message.delegation_plan', plan })
        spec.onDelegationPlan?.(plan)
      },
      mergeDelegationResult: (itemId, delta) => {
        emit({ kind: 'message.delegation_update', itemId, status: delta.status, result: delta.artifacts })
        spec.onDelegationUpdate?.(itemId, delta)
      },
      reportResult: (artifacts) => {
        collectedArtifacts.push(...artifacts)
      },
      reportExternalUsage: (usage) => {
        if (usage.costUsd && usage.costUsd > 0) usageSink.charge(usage.costUsd)
      },
      analyzeImage: buildAnalyzeImage(spec, ports, messageId, ac.signal),
    }
    const { tools, riskOf } = ports.toolRegistry.resolve(spec.tools ?? [], ctx)
    if (tools.length === 0) runLog.warn({ msg: 'no tools resolved for run', toolAllowlist: spec.tools ?? [] })

    // report_result is runtime infrastructure for child runs — always injected,
    // bypassing the allowlist. It's how children submit structured results.
    const toolsWithReport = spec.kind === 'child' ? [...tools, reportResultSpec().build(ctx)] : tools

    const engine = createEngine({
      messageId,
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
      tools: toolsWithReport,
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
    return { messageId, ...r, artifacts: collectedArtifacts }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof EngineSetupError ? 'agent_setup_failed' : 'agent_exception'
    runLog.error({ msg: 'run launch failed', code, err: message })
    // The synthetic terminal itself must not be able to reject launchMessage
    // (e.g. the same throwing store port that landed us here).
    try {
      emit({ kind: 'message.error', error: { code, message, tier: 'fatal' } })
    } catch (emitErr) {
      runLog.error({
        msg: 'synthetic terminal emit failed',
        err: emitErr instanceof Error ? emitErr.message : String(emitErr),
      })
    }
    return { messageId, status: 'failed', summary: '', messages: spec.history ?? [], used: emptyUsed(), artifacts: [] }
  } finally {
    try {
      release?.()
    } finally {
      ports.unregisterAbort(messageId)
    }
  }
}

/**
 * Vision capability for the tool context: first image-capable model in the
 * chain, driven through a SILENT nested launch (no events reach the parent's
 * sink; the visible analyze_image tool.call/result already represents it).
 * The nested run shares the parent's cancellation and rides the parent's slot.
 */
function buildAnalyzeImage(
  spec: MessageSpec,
  ports: LaunchPorts,
  parentMessageId: string,
  parentSignal: AbortSignal
): ToolRunContext['analyzeImage'] {
  const chain = [spec.provider, ...(spec.fallbackProviders ?? spec.provider.fallbackProviders ?? [])].filter(
    (p): p is ProviderInjection => !!p
  )
  const vision = chain.find(injectionSupportsImages)
  if (!vision) return undefined
  return async (prompt, image) => {
    // Remove the parent-signal listener once the nested run finishes, so
    // repeated analyzeImage calls don't accumulate stale abort listeners.
    let nestedAbort: (() => void) | null = null
    const r = await launchMessage(
      {
        kind: 'work',
        messageId: `${parentMessageId}:vision:${ulid()}`,
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
        // The ...ports spread would otherwise leak createTask into this
        // tool-less vision run; make its absence explicit.
        createTask: undefined,
        // Rides the parent's slot: the nested run must not compete for the pool
        // while its parent already holds a slot (that's the ledger-#5 shape).
        acquireSlot: async () => () => undefined,
        registerAbort: (_id, abort) => {
          nestedAbort = abort
          if (parentSignal.aborted) abort()
          else parentSignal.addEventListener('abort', abort, { once: true })
        },
        unregisterAbort: () => {
          if (nestedAbort) parentSignal.removeEventListener('abort', nestedAbort)
          nestedAbort = null
        },
      }
    )
    return r.summary
  }
}
