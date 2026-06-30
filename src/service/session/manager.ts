import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { applyAgentModel } from '@shared/agents/model-override'
import { DEFAULT_AGENT_DEF, defaultAgents } from '@shared/constants/agents'
import { createLogger } from '@shared/logger'
import { SYSTEM_SESSION_ID } from '@shared/system-session'
import type { ActorMessage } from '@shared/types/actor'
import type { AgentDefinition } from '@shared/types/agent'
import { allowlistForAgent } from '@shared/types/agent'
import { type BudgetConfig, defaultBudgetConfig } from '@shared/types/budgets'
import type { ProviderInjection } from '@shared/types/provider'
import type { PermissionMode, Task, TaskEvent, TaskOptions, TaskResult, TaskStatus } from '@shared/types/task'
import type { PermissionDecision } from '@shared/types/ui'
import { ulid } from 'ulid'

import { createMailbox } from '../actor/mailbox'
import { decodeActorState } from '../actor/state'
import { withAgentTypes } from '../agents/prompt'
import type { AgentStore } from '../agents/store'
import type { ConversationStore } from '../conversation/store'
import { createAgentDirectory } from '../directory/receptionist'
import type { Broadcaster } from '../ipc/broadcaster'
import { withSkills } from '../skills/prompt'
import type { SkillStore } from '../skills/store'
import { registerBuiltinTools } from '../tools/builtins'
import { createToolRegistry, type ToolRegistry } from '../tools/registry'
import { type AgentRunnerDeps, createAgentRunner, type ResidentHooks, runResident } from './agent-runner'
import { createPermissionRegistry, type PermissionRegistry } from './permission-registry'
import { createReplyRegistry } from './reply-registry'

const log = createLogger({ process: 'service' }).child({ component: 'session-manager' })

// Fixed company roster. Single source of truth: the seeded actor name equals
// the agent-def id. The CEO is first — it receives the kickoff goal — and then
// discovers the team heads at runtime via find_agents({ teamRole: 'head' }),
// which only sees LIVE actors — so every head must be seeded alongside its ICs.
// Derived from defaultAgents (the CEO plus every team member) rather than
// hardcoded, so a new builtin team becomes reachable without editing this list.
const COMPANY_ROLES = ['ceo', ...defaultAgents.filter((a) => a.team).map((a) => a.id)]

// A resident actor sleeps (its loop returns) after this long with an empty mailbox.
const IDLE_TIMEOUT_MS = 30_000
// Max per-message turn failures before the message is dead-lettered.
const MAX_RETRIES = 3
// How long an rpc caller waits for the resident's reply before resolving to ''.
const RPC_TIMEOUT_MS = 120_000

// Max execute→verify→rework rounds for autonomous ('goal') tasks. Bounded so a
// task that can't satisfy its criteria fails instead of looping forever.
const MAX_VERIFY_ROUNDS = 3

// Plan mode is read-only: it grants inspection tools but no shell, no fs writes,
// and no peekaboo interactions, so the agent physically cannot mutate anything
// while it produces a plan. Applies to the composer's main task only.
const PLAN_READONLY_ALLOWLIST = [
  'fs.read_file',
  'fs.list_dir',
  'fs.glob',
  'fs.grep',
  'web.fetch',
  'web.search',
  'peekaboo.see_screen',
  'peekaboo.list_apps',
  // update_plan only — exclude spawn_sub_agent, whose child could mutate.
  'agent.update_plan',
]

type QueuedTurn = { taskId: string; runTurn: () => Promise<void> }

type Session = {
  id: string
  provider: ProviderInjection
  permissionRegistry: PermissionRegistry
  messages: AgentMessage[]
  // FIFO queue of turns not yet started; the running turn is NOT in here.
  pending: QueuedTurn[]
  // taskId of the turn currently executing, or null when idle.
  running: string | null
}

type SessionManagerConfig = {
  store: ConversationStore
  broadcaster: Broadcaster
  maxConcurrent: number
  getProvider(key: string): ProviderInjection | undefined
  toolRegistry?: ToolRegistry
  skillStore?: SkillStore
  agentStore?: AgentStore
  /** Returns the user-configured per-task budgets; defaults apply when omitted. */
  getBudgetConfig?: () => BudgetConfig
  /** Live predicate from the tool-toggles store; disabled skills are dropped from the catalog. */
  isSkillEnabled?: (name: string) => boolean
}

export type SessionManager = {
  createSession(provider: ProviderInjection): { sessionId: string }
  /**
   * Ensure the dedicated system session (home of all global cron jobs) exists,
   * borrowing the caller session's provider so scheduled goals can run. Created
   * on first use; the provider snapshot is refreshed on every call to stay
   * current. Returns the system session id. Throws if `fromSessionId` is unknown.
   */
  ensureSystemSession(fromSessionId: string): string
  submitGoal(
    sessionId: string,
    goal: string,
    attachments?: import('@shared/types/task').Attachment[],
    agentDef?: AgentDefinition,
    onComplete?: (status: TaskStatus, error?: string) => void,
    options?: TaskOptions
  ): { taskId: string }
  startCompany(sessionId: string, goal: string): Promise<{ reply: string } | { delivered: true }>
  /** Wake an addressable actor by delivering a goal to it (fire-and-forget, system sender). */
  deliverToActor(sessionId: string, address: string, goal: string): void
  resolvePermission(sessionId: string, actionId: string, decision: PermissionDecision): void
  cancelTask(sessionId: string, taskId: string): void
  /**
   * Promote a queued task to the front of its session queue and interrupt the
   * running task (if any), so the promoted task runs next. The interrupted task
   * is cancelled with its partial output preserved in the session history.
   */
  interruptWith(sessionId: string, taskId: string): void
  endSession(sessionId: string): void
  deleteSession(sessionId: string): void
  renameSession(sessionId: string, title: string): void
  setSessionPinned(sessionId: string, pinned: boolean): void
  updateSessionSettings(sessionId: string, settings: import('@shared/types/ui').SessionSettings): void
  reorderSessions(orderedIds: string[]): void
  listSessions(): import('@shared/types/ui').SessionSummary[]
  getSessionTasks(sessionId: string): Task[]
  getUsageStats(rangeDays: number): import('@shared/types/usage').UsageStats
  /** @internal test hook */
  __ensureActorForTest?(sessionId: string, agentDefId: string, name?: string): import('@shared/types/actor').Actor
  /** @internal test hook */
  __sendMessageForTest?(
    sessionId: string,
    fromAddr: string | null,
    toAddr: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }>
  /** @internal test hook */
  __enqueueWithoutPumpForTest?(sessionId: string, goal: string): string
}

// session-manager owns sensible defaults for the agent-execution subsystem
// (cf. DEFAULT_AGENT_DEF). In production index.ts injects a shared registry;
// this default keeps createSessionManager usable for tests/scripts that omit it.
function buildDefaultRegistry(): ToolRegistry {
  const r = createToolRegistry()
  registerBuiltinTools(r)
  return r
}

export function createSessionManager(cfg: SessionManagerConfig): SessionManager {
  const { store, broadcaster } = cfg
  const toolRegistry = cfg.toolRegistry ?? buildDefaultRegistry()
  const sessions = new Map<string, Session>()

  // Inject the available-skills list and sub-agent-type catalog into the agent's
  // system prompt at task time, so newly-added skills/agents appear without a restart.
  const withPrompt = (def: AgentDefinition): AgentDefinition => {
    let systemPrompt = def.systemPrompt
    if (cfg.skillStore) {
      const isEnabled = cfg.isSkillEnabled ?? (() => true)
      systemPrompt = withSkills(
        systemPrompt,
        cfg.skillStore.list().filter((s) => isEnabled(s.name))
      )
    }
    if (cfg.agentStore) systemPrompt = withAgentTypes(systemPrompt, cfg.agentStore.list())
    return { ...def, systemPrompt }
  }

  // Read the user-configured per-task budgets at task-creation time; defaults
  // apply when no getter is wired (tests/scripts).
  const budgets = (): BudgetConfig => cfg.getBudgetConfig?.() ?? defaultBudgetConfig()

  let activeRunners = 0
  const waitQueue: Array<() => void> = []
  // One-shot task runs, keyed by taskId, so cancelTask can abort a specific in-flight run.
  const oneShotHandles = new Map<string, AbortController>()
  // The permission gate is resolved live from the session's persisted settings
  // at each tool call (see createAgentRunner.getPermissionMode), so toggling the
  // composer's permission mode takes effect on any in-flight or queued task in
  // the session regardless of when it was flipped. Defaults to 'ask'.
  const resolvePermissionMode = (sid: string): PermissionMode => store.getSessionSettings(sid)?.permissionMode ?? 'ask'
  // Resident actor run-loops, keyed by actor address. Populated in Task 6.
  const residentHandles = new Map<string, { abort(): void; deliver(msg: ActorMessage): void }>()
  const directory = createAgentDirectory({
    listActors: (s) => store.listActorsForSession(s),
    isLive: (address) => residentHandles.has(address),
    getAgentDef: (id) => cfg.agentStore?.get(id),
  })
  // Matches inbound rpc replies (by correlationId) to their awaiting callers.
  const replyRegistry = createReplyRegistry()

  async function acquireSlot(): Promise<void> {
    if (activeRunners < cfg.maxConcurrent) {
      activeRunners++
      return
    }
    await new Promise<void>((resolve) => waitQueue.push(resolve))
    // Slot was transferred to us by releaseSlot — do not increment again.
  }

  function releaseSlot(): void {
    const next = waitQueue.shift()
    if (next) next()
    else activeRunners--
  }

  // Run the next queued turn for a session, one at a time. A turn's finally
  // clears `running` and re-pumps, so the queue drains in order; cancelling or
  // completing the running turn naturally advances to the next.
  const pump = (session: Session): void => {
    if (session.running) return
    const next = session.pending.shift()
    if (!next) return
    session.running = next.taskId
    log.info({ msg: 'turn started', sessionId: session.id, taskId: next.taskId, queueDepth: session.pending.length })
    // Mark this turn as the active run in the UI. The renderer reducer maps
    // task.dispatched -> status 'running'; without it the turn stays 'pending'
    // and is misclassified as a queued card. workerId is vestigial in the
    // single-process model, so it is left empty.
    makeEmit(session.id)('task.dispatched', { taskId: next.taskId, workerId: '', ts: Date.now() })
    // Persist the running state too: live events only reach connected renderers,
    // so without this a task that is interrupted before reaching a terminal
    // status replays from the DB as 'pending' and reappears as a queued card.
    store.markTaskRunning(next.taskId)
    void next.runTurn().finally(() => {
      session.running = null
      pump(session)
    })
  }

  // Mark any sessions left 'active' from a previous run as interrupted.
  // Do not broadcast task.error here: at startup no renderer is connected,
  // and s.id is a session id, not a task id, which would produce spurious events.
  for (const s of store.getInterruptedSessions()) {
    store.updateSessionStatus(s.id, 'interrupted')
  }

  const makeEmit =
    (sessionId: string) =>
    (event: string, data: unknown): void => {
      const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
      const payload = obj ? { sessionId, ...obj } : data
      const taskId = obj?.taskId as string | undefined

      if (event === 'task.progress' && taskId && obj?.event) {
        store.appendTaskEvent(taskId, obj.event as TaskEvent)
      }
      if (event === 'task.error' && taskId && obj?.error) {
        store.appendTaskEvent(taskId, {
          kind: 'error',
          error: obj.error as Extract<TaskEvent, { kind: 'error' }>['error'],
          ts: Date.now(),
        })
      }
      if (event === 'task.plan' && taskId && Array.isArray(obj?.todos)) {
        const todos = obj.todos as import('@shared/types/task').PlanTodo[]
        store.saveTaskPlan(taskId, todos)
        log.debug({ msg: 'plan persisted', taskId, steps: todos.length })
      }
      if (event === 'task.criteria' && taskId && Array.isArray(obj?.criteria)) {
        const criteria = obj.criteria as import('@shared/types/task').AcceptanceCriterion[]
        store.saveTaskCriteria(taskId, criteria)
        log.info({ msg: 'acceptance criteria persisted', taskId, count: criteria.length })
      }
      if (event === 'task.verification' && taskId && obj?.round) {
        const round = obj.round as import('@shared/types/task').VerificationRound
        // Replace the full audit array each round (read-modify-write keeps it simple
        // and the array is tiny — bounded by maxVerifyRounds + 1).
        const existing = store.getTask(taskId)?.verifications ?? []
        store.saveTaskVerifications(taskId, [...existing, round])
        log.info({ msg: 'verification round persisted', taskId, round: round.round, verdict: round.verdict })
      }
      broadcaster.broadcast(event, payload)
    }

  // Resolve-or-create an addressable identity. With a name, an existing actor in
  // the same session is reused (so `send('researcher-1', …)` keeps hitting the
  // same identity); without a name a fresh ULID address is minted each time.
  const ensureActor = (sessionId: string, agentDefId: string, name?: string): import('@shared/types/actor').Actor => {
    if (name) {
      const existing = store.getActorByName(sessionId, name)
      if (existing) return existing
    }
    const now = Date.now()
    const actor: import('@shared/types/actor').Actor = {
      address: ulid(),
      agentDefId,
      sessionId,
      name: name ?? null,
      state: null,
      lastTaskId: null,
      createdAt: now,
      updatedAt: now,
    }
    store.upsertActor(actor)
    log.info({ msg: 'actor created', sessionId, address: actor.address, agentDefId, name: name ?? null })
    return actor
  }

  // Resolve `to` as either a raw ULID address or a session-scoped readable name.
  const resolveAddress = (sessionId: string, to: string): import('@shared/types/actor').Actor | undefined =>
    store.getActor(to) ?? store.getActorByName(sessionId, to)

  // Spawn ONE resident run-loop for an actor: create the residency Task, a
  // mailbox, and an abort handle; register the handle synchronously (before
  // runResident's first `await mailbox.receive()`) so a delivery issued right
  // after spawn is queued and picked up on the first receive (no race). The
  // loop drains messages one turn at a time and returns when it idles out or
  // aborts, at which point the Task is marked terminal and the handle dropped.
  const spawnResident = (
    sessionId: string,
    actor: import('@shared/types/actor').Actor
  ): { abort(): void; deliver(msg: ActorMessage): void } => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)
    const resolved = cfg.agentStore?.get(actor.agentDefId)
    if (!resolved) {
      log.warn({
        msg: 'agent def not found; falling back to default agent',
        sessionId,
        address: actor.address,
        agentDefId: actor.agentDefId,
      })
    }
    const def = resolved ?? DEFAULT_AGENT_DEF
    // One Task per residency (not per message).
    const taskId = ulid()
    const now = Date.now()
    const task: Task = {
      id: taskId,
      parentId: null,
      agentDefId: def.id,
      goal: `actor:${actor.address}`,
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: allowlistForAgent(def),
      budget: budgets().sub,
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [],
      attachments: [],
      result: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    }
    store.saveTask(task, sessionId)
    store.upsertActor({ ...actor, lastTaskId: taskId, updatedAt: now })
    broadcaster.broadcast('task.created', {
      sessionId,
      taskId,
      goal: task.goal,
      attachments: [],
      agentDefId: def.id,
      ts: now,
    })

    const mailbox = createMailbox()
    const abort = new AbortController()
    const handle = { abort: () => abort.abort(), deliver: (m: ActorMessage) => mailbox.deliver(m) }
    // Register synchronously so the immediately-following deliver is queued.
    residentHandles.set(actor.address, handle)
    log.info({ msg: 'resident spawned', sessionId, address: actor.address, taskId })

    const restored = decodeActorState(actor.state)
    if (actor.state && restored.length === 0) {
      log.warn({
        msg: 'actor state decode failed, starting fresh',
        sessionId,
        address: actor.address,
        component: 'actor-state',
      })
    } else if (restored.length > 0) {
      log.info({
        msg: 'actor state replayed',
        sessionId,
        address: actor.address,
        messageCount: restored.length,
        component: 'actor-state',
      })
    }

    const hooks: ResidentHooks = {
      acquireTurnSlot: () => acquireSlot(),
      releaseTurnSlot: () => releaseSlot(),
      onConsumed: (msgId, state) => store.consumeAndPersist(msgId, actor.address, state, Date.now()),
      onReply: (correlationId, summary) => replyRegistry.resolve(correlationId, summary),
      // Per-message retry/deadletter: bump the retry count; once it exceeds the
      // limit, dead-letter so it stops being re-drained. The loop keeps running.
      onError: (msgId) => {
        const n = store.bumpRetries(msgId)
        if (n > MAX_RETRIES) {
          store.markDead(msgId)
          log.error({ msg: 'message dead-lettered', sessionId, address: actor.address, msgId, retries: n })
        } else {
          log.warn({ msg: 'message turn failed, will retry', sessionId, address: actor.address, msgId, retries: n })
        }
      },
    }
    const deps: AgentRunnerDeps = {
      task,
      provider: applyAgentModel(session.provider, def),
      agentDefinition: withPrompt(def),
      sessionId,
      getPermissionMode: () => resolvePermissionMode(sessionId),
      emit: makeEmit(sessionId),
      permissionRegistry: session.permissionRegistry,
      toolRegistry,
      initialMessages: restored,
      signal: abort.signal,
      selfAddress: actor.address,
      sendMessage: (from, to, payload, kind) => sendMessage(sessionId, from, to, payload, kind),
      spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
      findPeers: (q) => directory.find(sessionId, q, actor.address),
      writeAgent: (def) =>
        cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
      writeSkill: (skill) =>
        cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
    }
    void runResident(deps, mailbox, hooks, IDLE_TIMEOUT_MS)
      .then(() => store.updateTaskStatus(taskId, 'completed'))
      .catch((err) => {
        log.error({ msg: 'resident loop failed', sessionId, address: actor.address, taskId, err: String(err) })
        store.updateTaskStatus(taskId, 'failed')
      })
      .finally(() => {
        // Close the idle-sleep vs live-deliver race: a sendMessage can fetch
        // this still-registered handle and deliver() into the mailbox in the
        // window AFTER runResident exited on idle-timeout but BEFORE we delete
        // the handle here. Such a message would land in a mailbox with no
        // receiver. But every message is enqueueMessage'd in the DB before
        // delivery, so any "lost" delivery is still an unconsumed DB row.
        // Delete the handle first, then re-drain: redrainAddress re-spawns only
        // if unconsumed rows remain. Bounded: consumed rows are markConsumed'd
        // and failing rows hit the 3-retry deadletter (markDead), so
        // allUnconsumedFor eventually returns empty — no infinite loop.
        residentHandles.delete(actor.address)
        redrainAddress(actor.address)
      })
    return handle
  }

  const sendMessage = async (
    sessionId: string,
    fromAddr: string | null,
    toAddr: string,
    payload: string,
    kind: 'send' | 'rpc'
  ): Promise<{ reply: string } | { delivered: true }> => {
    const target = resolveAddress(sessionId, toAddr)
    const now = Date.now()
    const msgId = ulid()
    store.enqueueMessage({
      id: msgId,
      toAddr: target?.address ?? toAddr,
      fromAddr,
      kind,
      // correlationId is reserved for Plan B's run-loop reply matching; today an rpc reply is the inline-awaited activation result.
      correlationId: kind === 'rpc' ? msgId : null,
      payload,
      consumed: false,
      retries: 0,
      dead: !target,
      ts: now,
    })
    if (!target) {
      log.warn({ msg: 'message to unknown address dead-lettered', sessionId, toAddr, kind })
      return kind === 'rpc' ? { reply: '' } : { delivered: true }
    }
    log.info({ msg: 'message sent', sessionId, fromAddr, toAddr: target.address, kind, correlationId: msgId })

    // Resolve-or-spawn the resident loop, then deliver. The payload is the raw
    // goal text; runResident passes msg.payload straight to promptOnce.
    const handle = residentHandles.get(target.address) ?? spawnResident(sessionId, target)
    handle.deliver({
      id: msgId,
      toAddr: target.address,
      fromAddr,
      kind,
      correlationId: kind === 'rpc' ? msgId : null,
      payload,
      consumed: false,
      retries: 0,
      dead: false,
      ts: now,
    })
    if (kind === 'rpc') {
      // The caller (fromAddr) is mid-turn and holds a turn-slot. Yield it while we
      // await the reply so the callee can acquire a slot — this is what prevents
      // deadlock under maxConcurrent. Re-acquire before returning to the caller's loop.
      // Infer "caller holds a turn-slot" from "caller has a registered resident
      // loop". Valid ONLY because a resident issues rpc exclusively from inside
      // its slot-holding promptOnce, and issues them serially.
      const callerHoldsSlot = !!fromAddr && residentHandles.has(fromAddr)
      if (callerHoldsSlot) releaseSlot()
      try {
        return { reply: await replyRegistry.awaitReply(msgId, RPC_TIMEOUT_MS) }
      } finally {
        if (callerHoldsSlot) await acquireSlot()
      }
    }
    return { delivered: true }
  }

  const spawnChild = async (
    sessionId: string,
    parentTaskId: string,
    newGoal: string,
    suggestedTools?: string[],
    providerKey?: string,
    agentType?: string
  ): Promise<{ childTaskId: string; result: TaskResult }> => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`session ${sessionId} not found`)

    // Resolve the sub-agent type; an unknown type falls back to the default.
    const def = (agentType ? cfg.agentStore?.get(agentType) : undefined) ?? DEFAULT_AGENT_DEF
    if (agentType && def.id !== agentType) {
      log.warn({ msg: 'agentType not found, falling back to default', agentType })
    }

    const lookedUp = providerKey ? cfg.getProvider(providerKey) : undefined
    if (providerKey && !lookedUp) {
      log.warn({ msg: 'providerKey not found, falling back to session provider', providerKey })
    }
    // The agent type may pin a model tier (model + thinking depth); otherwise
    // inherit the provider's. Preserves the provider's fallback chain.
    const baseProvider = lookedUp ?? session.provider
    const resolvedProvider = applyAgentModel(baseProvider, def)

    const childTaskId = ulid()
    const now = Date.now()
    const childTask: Task = {
      id: childTaskId,
      parentId: parentTaskId,
      agentDefId: def.id,
      goal: newGoal,
      status: 'pending',
      assignedWorkerId: null,
      toolAllowlist: suggestedTools ?? allowlistForAgent(def),
      budget: budgets().sub,
      used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
      history: [],
      attachments: [],
      result: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    }
    store.saveTask(childTask, sessionId)
    log.info({ msg: 'child spawned', sessionId, parentTaskId, childTaskId, agentDefId: def.id })

    // A child needs its own task.created so the renderer builds a real task
    // record; without it the child's later events arrive for an unknown taskId
    // and degrade into an "(unknown task)" stub. parentTaskId/agentDefId let the
    // UI group it as a distinct sub-agent block.
    broadcaster.broadcast('task.created', {
      sessionId,
      taskId: childTaskId,
      goal: newGoal,
      attachments: [],
      parentTaskId,
      agentDefId: def.id,
      ts: now,
    })
    broadcaster.broadcast('task.handoff.spawned', { sessionId, parentTaskId, childTaskId, ts: now })

    return new Promise<{ childTaskId: string; result: TaskResult }>((resolve) => {
      const startChild = async (): Promise<void> => {
        await acquireSlot()
        const abort = new AbortController()
        oneShotHandles.set(childTaskId, abort)
        const runner = createAgentRunner({
          task: childTask,
          provider: resolvedProvider,
          agentDefinition: withPrompt(def),
          sessionId,
          getPermissionMode: () => resolvePermissionMode(sessionId),
          emit: makeEmit(sessionId),
          permissionRegistry: session.permissionRegistry,
          toolRegistry,
          initialMessages: [],
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
          findPeers: (q) => directory.find(sessionId, q),
          writeAgent: (def) =>
            cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
          writeSkill: (skill) =>
            cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
          // Children verify single-shot; only top-level submitGoal tasks run the verify loop.
          maxVerifyRounds: 0,
          maxIterationsOverride: budgets().maxIterations,
        })
        try {
          const { status, summary } = await runner.run()
          // Persist the child's terminal status. Without this the child row stays
          // 'pending' forever (only submitGoal updated status before), so on
          // rehydrate the finished sub-agent reads as still-running and the chat
          // looks stuck executing.
          store.updateTaskStatus(childTaskId, status)
          resolve({ childTaskId, result: { summary, artifacts: [] } })
        } catch (err) {
          log.error({
            msg: 'spawnChild run failed',
            childTaskId,
            err: err instanceof Error ? err.message : String(err),
          })
          try {
            store.appendTaskEvent(childTaskId, {
              kind: 'error',
              error: { code: 'run_failed', message: err instanceof Error ? err.message : String(err), tier: 'fatal' },
              ts: Date.now(),
            })
          } catch (appendErr) {
            log.error({ msg: 'failed to persist child error event', childTaskId, err: String(appendErr) })
          }
          try {
            store.updateTaskStatus(childTaskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark child failed', childTaskId, err: String(statusErr) })
          }
          // Resolve (not reject) so the parent's spawn tool gets a result and continues.
          resolve({ childTaskId, result: { summary: '', artifacts: [] } })
        } finally {
          oneShotHandles.delete(childTaskId)
          releaseSlot()
        }
      }
      void startChild()
    })
  }

  const getOrRehydrate = (sessionId: string): Session | undefined => {
    const live = sessions.get(sessionId)
    if (live) return live
    const stored = store.getSession(sessionId)
    if (!stored) return undefined
    const rehydrated: Session = {
      id: sessionId,
      provider: stored.providerSnapshot,
      permissionRegistry: createPermissionRegistry(makeEmit(sessionId)),
      messages: store.getAgentSnapshot(sessionId),
      pending: [],
      running: null,
    }
    store.updateSessionStatus(sessionId, 'active')
    sessions.set(sessionId, rehydrated)
    return rehydrated
  }

  // Re-activate an addressed actor and re-deliver ALL its pending (unconsumed)
  // DB messages in ts order, so the resident loop drains them as it would live.
  // Used both for startup crash recovery and for the post-completion re-drain
  // that closes the idle-sleep vs live-deliver race (see spawnResident's
  // .finally). Re-spawns only when unconsumed rows remain, so it is a no-op for
  // an address whose mailbox is already empty.
  //
  // NOTE: after a crash/restart re-drain, an rpc message's original caller is
  // gone (its awaitReply promise died with the previous process), so when the
  // resident later calls replyRegistry.resolve it finds no waiter and warns
  // ("rpc reply has no waiter (caller gone)") — this is expected, not a bug.
  function redrainAddress(address: string): void {
    const actor = store.getActor(address)
    if (!actor || !actor.sessionId) return
    const pending = store.allUnconsumedFor(address)
    if (pending.length === 0) return
    const session = getOrRehydrate(actor.sessionId)
    if (!session) return
    const handle = residentHandles.get(address) ?? spawnResident(actor.sessionId, actor)
    for (const msg of pending) handle.deliver(msg)
    log.info({ msg: 'redrain', address, sessionId: actor.sessionId, pending: pending.length })
  }

  // Crash recovery: a previous run may have left messages enqueued but never
  // delivered. Re-drain each addressed actor on startup.
  for (const address of store.listUnconsumedAddresses()) {
    redrainAddress(address)
  }

  return {
    createSession(provider) {
      const sessionId = ulid()
      store.createSession(sessionId, provider)
      const permissionRegistry = createPermissionRegistry(makeEmit(sessionId))
      sessions.set(sessionId, {
        id: sessionId,
        provider,
        permissionRegistry,
        messages: [],
        pending: [],
        running: null,
      })
      broadcaster.broadcast('session.created', { sessionId, title: null, ts: Date.now() })
      log.info({ msg: 'session created', sessionId })
      // Keep the long-lived system session's provider current: a new session
      // always carries the latest configured provider (model/key), so sync it
      // onto the system session (when it exists) — that way scheduled jobs fire
      // with up-to-date credentials without waiting for the next schedule_task.
      if (store.getSession(SYSTEM_SESSION_ID)) {
        store.updateSessionProvider(SYSTEM_SESSION_ID, provider)
        const liveSystem = sessions.get(SYSTEM_SESSION_ID)
        if (liveSystem) liveSystem.provider = provider
      }
      return { sessionId }
    },

    ensureSystemSession(fromSessionId) {
      const from = getOrRehydrate(fromSessionId)
      if (!from) throw new Error(`cannot bootstrap system session: source session ${fromSessionId} not found`)
      const existing = store.getSession(SYSTEM_SESSION_ID)
      if (existing) {
        // Keep the provider current: the user may have switched model/key since
        // the system session was first created (it lives forever, unlike a chat).
        store.updateSessionProvider(SYSTEM_SESSION_ID, from.provider)
        const live = sessions.get(SYSTEM_SESSION_ID)
        if (live) live.provider = from.provider
        log.debug({ msg: 'system session provider refreshed', fromSessionId })
      } else {
        store.createSession(SYSTEM_SESSION_ID, from.provider)
        sessions.set(SYSTEM_SESSION_ID, {
          id: SYSTEM_SESSION_ID,
          provider: from.provider,
          permissionRegistry: createPermissionRegistry(makeEmit(SYSTEM_SESSION_ID)),
          messages: [],
          pending: [],
          running: null,
        })
        store.setSessionTitle(SYSTEM_SESSION_ID, 'Scheduled tasks')
        log.info({ msg: 'system session created', fromSessionId })
      }
      return SYSTEM_SESSION_ID
    },

    submitGoal(sessionId, goal, attachmentsArg, agentDefArg, onComplete, options) {
      const session = getOrRehydrate(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)

      const attachments = attachmentsArg ?? []
      const now = Date.now()
      const existingTasks = store.getSessionTasks(sessionId)
      const isFirst = existingTasks.length === 0

      // Follow-up continuation: when the session is idle (no top-level turn
      // running or queued), a new goal continues the most-recent top-level task
      // instead of spawning a new one. A session is one conversation thread —
      // session.messages already carries the full prior context — so a fresh root
      // task per follow-up would clutter the transcript with sibling cards (e.g. a
      // "继续" card). Whether the follow-up is really a continuation or a new
      // objective is left to the agent's own judgment mid-turn (it sees the full
      // history and can reset its acceptance criteria if it decides the request is
      // new). While a turn IS running/queued, submissions still queue as distinct
      // tasks so the queue/interrupt feature is preserved.
      const busy = session.running !== null || session.pending.length > 0
      const roots = existingTasks.filter((t) => t.parentId == null).sort((a, b) => a.createdAt - b.createdAt)
      const lastRoot = roots[roots.length - 1]
      const continuing = !busy && lastRoot ? lastRoot : undefined

      // Resolve agent definition: a continuation keeps the original task's agent
      // so the system prompt doesn't change mid-conversation. Otherwise explicit
      // arg wins, then options.agentType lookup, then DEFAULT_AGENT_DEF (mirrors
      // spawnChild's resolution logic).
      const resolvedByType = options?.agentType ? cfg.agentStore?.get(options.agentType) : undefined
      if (options?.agentType && !resolvedByType) {
        log.warn({ msg: 'agentType not found, falling back to default', agentType: options.agentType })
      }
      const agentDef = continuing
        ? (cfg.agentStore?.get(continuing.agentDefId) ?? agentDefArg ?? resolvedByType ?? DEFAULT_AGENT_DEF)
        : (agentDefArg ?? resolvedByType ?? DEFAULT_AGENT_DEF)

      const taskId = continuing ? continuing.id : ulid()
      // Plan mode forces the read-only tool set regardless of the agent's scope,
      // so the agent can investigate but not mutate while planning.
      const toolAllowlist = options?.executionMode === 'plan' ? PLAN_READONLY_ALLOWLIST : allowlistForAgent(agentDef)
      // The task object the runner drives this turn. A continuation reuses the
      // existing row's id and carries its acceptance criteria (so the runner
      // skips Phase A and continues toward the same criteria), but prompts with
      // the new follow-up text and gets a fresh budget envelope for the turn.
      const task: Task = continuing
        ? {
            ...continuing,
            goal,
            attachments,
            budget: budgets().main,
            history: [],
            result: null,
            endedAt: null,
            status: 'pending',
          }
        : {
            id: taskId,
            parentId: null,
            agentDefId: agentDef.id,
            goal,
            status: 'pending',
            assignedWorkerId: null,
            toolAllowlist,
            budget: budgets().main,
            used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
            history: [],
            attachments,
            result: null,
            createdAt: now,
            startedAt: null,
            endedAt: null,
            cwd: options?.cwd,
            permissionMode: options?.permissionMode,
            executionMode: options?.executionMode,
            acceptanceCriteria: options?.acceptanceCriteria,
          }

      if (continuing) {
        // No new row: append the follow-up as a user message on the existing
        // task so the transcript shows it (the runner feeds it to the LLM but
        // emits no user-message event of its own), then re-open the card.
        makeEmit(sessionId)('task.progress', {
          taskId,
          event: { kind: 'llm.message', role: 'user', content: goal, ts: now },
        })
        store.updateSessionLastActive(sessionId)
        log.info({ msg: 'goal continues task', sessionId, taskId, goalLen: goal.length, agentDefId: task.agentDefId })
      } else {
        store.saveTask(task, sessionId)
        broadcaster.broadcast('task.created', { sessionId, taskId, goal, attachments, ts: now })
        store.updateSessionLastActive(sessionId)
        log.info({
          msg: 'goal submitted',
          sessionId,
          taskId,
          agentDefId: agentDef.id,
          cwd: options?.cwd ?? null,
          permissionMode: options?.permissionMode ?? 'ask',
          executionMode: options?.executionMode ?? 'goal',
        })

        if (isFirst) {
          const title = goal.slice(0, 60)
          store.setSessionTitle(sessionId, title)
          broadcaster.broadcast('session.updated', { sessionId, title, lastActiveAt: now, ts: now })
        }
      }

      const runTurn = async (): Promise<void> => {
        // Register the abort handle BEFORE awaiting a slot: pump() has already
        // set session.running and shifted this turn out of pending, so until the
        // handle exists a cancel/interrupt issued while we wait for a slot would
        // find the turn nowhere and silently no-op. Registering first latches the
        // signal; the runner short-circuits to 'cancelled' once it starts.
        const abort = new AbortController()
        oneShotHandles.set(taskId, abort)
        await acquireSlot()
        const runner = createAgentRunner({
          task,
          provider: session.provider,
          agentDefinition: withPrompt(agentDef),
          sessionId,
          getPermissionMode: () => resolvePermissionMode(sessionId),
          emit: makeEmit(sessionId),
          permissionRegistry: session.permissionRegistry,
          toolRegistry,
          initialMessages: session.messages,
          saveSnapshot: (messages, used, contextWindow) => {
            session.messages = messages
            store.saveAgentSnapshot(sessionId, messages)
            store.saveTaskUsage(taskId, used, contextWindow)
          },
          signal: abort.signal,
          spawnChild: (pt, ng, st, pk, at) => spawnChild(sessionId, pt, ng, st, pk, at),
          findPeers: (q) => directory.find(sessionId, q),
          writeAgent: (def) =>
            cfg.agentStore?.save(def) ?? { ok: false, code: 'no_store', message: 'agent store unavailable' },
          writeSkill: (skill) =>
            cfg.skillStore?.save(skill) ?? { ok: false, code: 'no_store', message: 'skill store unavailable' },
          maxVerifyRounds: MAX_VERIFY_ROUNDS,
          maxIterationsOverride: budgets().maxIterations,
        })
        try {
          const { status } = await runner.run()
          store.updateTaskStatus(taskId, status)
          onComplete?.(status)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ msg: 'runTurn failed', taskId, err: message })
          try {
            store.appendTaskEvent(taskId, {
              kind: 'error',
              error: { code: 'run_failed', message, tier: 'fatal' },
              ts: Date.now(),
            })
          } catch (appendErr) {
            log.error({ msg: 'failed to persist error event', taskId, err: String(appendErr) })
          }
          try {
            store.updateTaskStatus(taskId, 'failed')
          } catch (statusErr) {
            log.error({ msg: 'failed to mark task failed', taskId, err: String(statusErr) })
          }
          onComplete?.('failed', message)
        } finally {
          oneShotHandles.delete(taskId)
          releaseSlot()
        }
      }

      session.pending.push({ taskId, runTurn })
      pump(session)
      return { taskId }
    },

    async startCompany(sessionId, goal) {
      // Seed the fixed roster as named, addressable actors, then rpc-kick the
      // CEO; its reply is the result of the whole run.
      log.info({ msg: 'company started', sessionId, goalLen: goal.length })
      // Self-heal: re-seed any company-critical role the user deleted so
      // find_agents discovery and the 'ceo' kickoff resolve to the real defs.
      for (const roleId of COMPANY_ROLES) {
        if (cfg.agentStore?.get(roleId)) continue
        const def = defaultAgents.find((d) => d.id === roleId)
        if (!def) continue
        const r = cfg.agentStore?.save(def)
        if (r?.ok) log.warn({ msg: 'company role re-seeded (was missing)', sessionId, roleId })
        else
          log.error({
            msg: 'company role re-seed failed',
            sessionId,
            roleId,
            err: r && !r.ok ? r.message : 'no agent store',
          })
      }
      for (const roleId of COMPANY_ROLES) {
        ensureActor(sessionId, roleId, roleId)
      }
      return sendMessage(sessionId, null, 'ceo', goal, 'rpc')
    },

    resolvePermission(sessionId, actionId, decision) {
      sessions.get(sessionId)?.permissionRegistry.resolve(actionId, decision)
    },

    cancelTask(sessionId, taskId) {
      log.info({ msg: 'task cancel requested', sessionId, taskId })
      // Running (or about-to-run with a registered abort handle): abort the run.
      const handle = oneShotHandles.get(taskId)
      if (handle) {
        handle.abort()
        return
      }
      // Queued but not yet started: remove from the queue and mark cancelled.
      const session = sessions.get(sessionId)
      const idx = session ? session.pending.findIndex((q) => q.taskId === taskId) : -1
      if (session && idx !== -1) {
        session.pending.splice(idx, 1)
        store.updateTaskStatus(taskId, 'cancelled')
        // Surface to the UI so the queued card is dropped; reducer maps a
        // task.error with code 'cancelled' to the cancelled status.
        makeEmit(sessionId)('task.error', {
          taskId,
          error: { code: 'cancelled', message: 'Cancelled before start', tier: 'fatal' },
          ts: Date.now(),
        })
        log.info({ msg: 'queued task cancelled', sessionId, taskId })
        return
      }
      // No in-memory session (e.g. an interrupted session reopened in the UI
      // but never re-dispatched). A non-terminal task here is a zombie — mark
      // it cancelled and emit so the UI drops the phantom queued card. Terminal
      // tasks are left alone.
      const task = store.getTask(taskId)
      if (task && !['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
        store.updateTaskStatus(taskId, 'cancelled')
        makeEmit(sessionId)('task.error', {
          taskId,
          error: { code: 'cancelled', message: 'Cancelled before start', tier: 'fatal' },
          ts: Date.now(),
        })
        log.info({ msg: 'zombie task cancelled (no in-memory session)', sessionId, taskId })
        return
      }
      log.warn({ msg: 'cancelTask: unknown or already-finished task', sessionId, taskId })
    },

    interruptWith(sessionId, taskId) {
      const session = sessions.get(sessionId)
      if (!session) {
        log.warn({ msg: 'interruptWith: unknown session', sessionId, taskId })
        return
      }
      const idx = session.pending.findIndex((q) => q.taskId === taskId)
      if (idx === -1) {
        log.warn({ msg: 'interruptWith: task not in queue', sessionId, taskId })
        return
      }
      // Jump the queue: move the chosen turn to the front.
      const [item] = session.pending.splice(idx, 1)
      session.pending.unshift(item)
      const cancelledTaskId = session.running
      log.info({ msg: 'task interrupted, promoted to front', sessionId, taskId, cancelledTaskId })
      if (cancelledTaskId) {
        // Abort the running task; its run returns 'cancelled' with partial
        // output already saved via saveSnapshot, and its finally re-pumps,
        // which now picks the promoted item.
        oneShotHandles.get(cancelledTaskId)?.abort()
      } else {
        // Idle session — run the promoted item immediately.
        pump(session)
      }
    },

    endSession(sessionId) {
      log.info({ msg: 'session ended', sessionId })
      store.updateSessionStatus(sessionId, 'ended')
      sessions.delete(sessionId)
    },

    deleteSession(sessionId) {
      log.info({ msg: 'session deleted', sessionId })
      // Abort any in-flight runs for this session before dropping its rows.
      for (const t of store.getSessionTasks(sessionId)) oneShotHandles.get(t.id)?.abort()
      sessions.delete(sessionId)
      store.deleteSession(sessionId)
    },

    renameSession(sessionId, title) {
      store.setSessionTitle(sessionId, title)
    },

    setSessionPinned(sessionId, pinned) {
      store.setSessionPinned(sessionId, pinned)
    },

    updateSessionSettings(sessionId, settings) {
      // Persisting is all that's needed for the permission gate to follow the
      // toggle: the runner resolves permissionMode live from these settings on
      // each tool call (resolvePermissionMode), so any in-flight or queued task
      // in the session picks up the change on its next call.
      store.setSessionSettings(sessionId, settings)
      log.info({
        msg: 'session settings updated',
        sessionId,
        cwd: settings.cwd ?? null,
        permissionMode: settings.permissionMode ?? null,
        executionMode: settings.executionMode ?? null,
        agentType: settings.agentType ?? null,
      })
    },

    reorderSessions(orderedIds) {
      store.reorderSessions(orderedIds)
    },

    listSessions() {
      return store.listSessions()
    },

    getSessionTasks(sessionId) {
      return store.getSessionTasks(sessionId)
    },

    getUsageStats(rangeDays) {
      return store.getUsageStats(rangeDays)
    },

    // Test-only: exercise actor resolution without driving a full run.
    __ensureActorForTest(sessionId: string, agentDefId: string, name?: string) {
      return ensureActor(sessionId, agentDefId, name)
    },

    // Test-only: enqueue a goal WITHOUT auto-pumping, leaving the session idle
    // with a pending turn. submitGoal always pumps, so the only way to reach the
    // idle-with-pending state (exercised by interruptWith's else branch) is to
    // briefly block pump with a sentinel `running`, then clear it. Returns taskId.
    __enqueueWithoutPumpForTest(sessionId: string, goal: string): string {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`session ${sessionId} not found`)
      const prevRunning = session.running
      session.running = '__test_block__'
      const { taskId } = this.submitGoal(sessionId, goal)
      session.running = prevRunning
      return taskId
    },

    deliverToActor(sessionId, address, goal) {
      const session = getOrRehydrate(sessionId)
      if (!session) {
        log.warn({ msg: 'deliverToActor: session not found, dropping wake', sessionId, address })
        return
      }
      void sendMessage(sessionId, 'system', address, goal, 'send').catch((err) => {
        log.error({
          msg: 'deliverToActor delivery failed',
          sessionId,
          address,
          err: err instanceof Error ? err.message : String(err),
        })
      })
    },

    // Test-only: drive sendMessage directly.
    __sendMessageForTest(
      sessionId: string,
      fromAddr: string | null,
      toAddr: string,
      payload: string,
      kind: 'send' | 'rpc'
    ) {
      return sendMessage(sessionId, fromAddr, toAddr, payload, kind)
    },
  }
}
