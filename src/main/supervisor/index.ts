import { EventEmitter } from 'node:events'
import { createLogger } from '@shared/logger'
import { type Inbound, type Outbound, OutboundSchema } from '@shared/types/ipc'
import type { Task } from '@shared/types/task'
import { ulid } from 'ulid'

import type { WorkerHandle, WorkerSpawner } from './spawner'

export type SupervisorConfig = {
  spawner: WorkerSpawner
  workerEntry: string
  poolSize: number
  /** ms of heartbeat absence before declaring a worker dead. Default 30_000. */
  heartbeatTimeoutMs?: number
  /** ms between watchdog checks. Default 5_000. */
  watchdogIntervalMs?: number
}

type Slot = {
  handle: WorkerHandle
  state: 'idle' | 'busy' | 'dead'
  currentTaskId: string | null
  lastHeartbeat: number
}

type SupervisorEvents = {
  'task.dispatched': (taskId: string, workerId: string) => void
  'task.complete': (taskId: string, result: Outbound & { type: 'task.complete' }) => void
  'task.error': (taskId: string, error: unknown) => void
  'task.handoff': (parentTaskId: string, newGoal: string, suggestedTools: string[] | undefined) => void
  progress: (taskId: string, event: Outbound & { type: 'progress' }) => void
  'tool.call': (taskId: string, workerId: string, msg: Outbound & { type: 'tool.call' }) => void
  'permission.request': (
    taskId: string,
    workerId: string,
    msg: Outbound & { type: 'permission.request' },
  ) => void
}

export type Supervisor = {
  start(): Promise<void>
  dispatch(task: Task): void
  sendToWorker(workerId: string, msg: Inbound): boolean
  shutdown(): Promise<void>
  on<K extends keyof SupervisorEvents>(event: K, cb: SupervisorEvents[K]): void
}

export function createSupervisor(cfg: SupervisorConfig): Supervisor {
  const log = createLogger({ process: 'main' }).child({ component: 'supervisor' })
  const ee = new EventEmitter()
  const slots: Slot[] = []
  const queue: Task[] = []
  let shuttingDown = false

  const send = (slot: Slot, msg: Inbound): void => slot.handle.send(msg)

  const tryDispatchNext = (): void => {
    if (shuttingDown) return
    if (queue.length === 0) return
    const slot = slots.find((s) => s.state === 'idle')
    if (!slot) return
    const task = queue.shift() as Task
    slot.state = 'busy'
    slot.currentTaskId = task.id
    log.info({ msg: 'dispatching', taskId: task.id, workerId: slot.handle.workerId })
    // Provider injection added in Task 12; placeholder keeps the schema valid.
    send(slot, {
      type: 'task.assign',
      task,
      promptContext: '',
      provider: { id: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'placeholder' },
    })
    ee.emit('task.dispatched', task.id, slot.handle.workerId)
  }

  const handleOutbound = (slot: Slot, raw: unknown): void => {
    const parsed = OutboundSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn({ msg: 'invalid outbound', issues: parsed.error.issues })
      return
    }
    const m = parsed.data
    switch (m.type) {
      case 'heartbeat':
        slot.lastHeartbeat = m.ts
        return
      case 'task.complete':
        log.info({ msg: 'task complete', taskId: m.taskId })
        slot.state = 'idle'
        slot.currentTaskId = null
        ee.emit('task.complete', m.taskId, m)
        tryDispatchNext()
        return
      case 'task.error':
        log.error({ msg: 'task error', taskId: m.taskId, error: m.error })
        slot.state = 'idle'
        slot.currentTaskId = null
        ee.emit('task.error', m.taskId, m.error)
        tryDispatchNext()
        return
      case 'progress':
        if (slot.currentTaskId) ee.emit('progress', slot.currentTaskId, m)
        return
      case 'tool.call':
        if (slot.currentTaskId) ee.emit('tool.call', slot.currentTaskId, slot.handle.workerId, m)
        return
      case 'permission.request':
        if (slot.currentTaskId)
          ee.emit('permission.request', slot.currentTaskId, slot.handle.workerId, m)
        return
      case 'task.handoff':
        ee.emit('task.handoff', m.parentTaskId, m.newGoal, m.suggestedTools)
        return
      default:
        log.debug({ msg: 'unhandled outbound', type: (m as { type: string }).type })
    }
  }

  const spawnSlot = (): Slot => {
    const workerId = `w-${ulid()}`
    const handle = cfg.spawner.spawn({ entry: cfg.workerEntry, workerId })
    const slot: Slot = { handle, state: 'idle', currentTaskId: null, lastHeartbeat: Date.now() }
    handle.onMessage((m) => handleOutbound(slot, m))
    handle.onExit((code) => {
      log.warn({ msg: 'worker exited', workerId, code })
      slot.state = 'dead'
    })
    return slot
  }

  const replaceSlot = (slot: Slot, reason: string): void => {
    // Mark dead synchronously so a subsequent watchdog tick (before the child's
    // async 'exit' fires) does not re-enter replaceSlot on the same slot.
    if (slot.state === 'dead') return
    slot.state = 'dead'
    log.warn({ msg: 'replacing worker', workerId: slot.handle.workerId, reason })
    const orphanedTaskId = slot.currentTaskId
    slot.currentTaskId = null
    try {
      slot.handle.kill()
    } catch (e) {
      log.debug({ msg: 'kill threw (worker may already be dead)', err: String(e) })
    }
    const idx = slots.indexOf(slot)
    if (idx >= 0) slots[idx] = spawnSlot()
    if (orphanedTaskId) {
      ee.emit('task.error', orphanedTaskId, {
        code: 'worker_died',
        message: `worker replaced: ${reason}`,
        tier: 'fatal',
      })
    }
    tryDispatchNext()
  }

  const watchdogTimeout = cfg.heartbeatTimeoutMs ?? 30_000
  const watchdogInterval = cfg.watchdogIntervalMs ?? 5_000
  let watchdog: NodeJS.Timeout | null = null

  const tickWatchdog = (): void => {
    const now = Date.now()
    for (const slot of slots) {
      if (slot.state === 'dead') continue
      if (now - slot.lastHeartbeat > watchdogTimeout) {
        replaceSlot(slot, `heartbeat absent for ${now - slot.lastHeartbeat}ms`)
      }
    }
  }

  return {
    async start(): Promise<void> {
      for (let i = 0; i < cfg.poolSize; i++) slots.push(spawnSlot())
      // Wait one tick so child IPC pipes are ready before any dispatch.
      await new Promise((r) => setImmediate(r))
      watchdog = setInterval(tickWatchdog, watchdogInterval)
      watchdog.unref?.()
      log.info({ msg: 'supervisor started', poolSize: cfg.poolSize })
    },
    dispatch(task: Task): void {
      if (shuttingDown) throw new Error('supervisor is shutting down')
      queue.push(task)
      tryDispatchNext()
    },
    sendToWorker(workerId, msg): boolean {
      const slot = slots.find((s) => s.handle.workerId === workerId)
      if (!slot || slot.state === 'dead') return false
      send(slot, msg)
      return true
    },
    async shutdown(): Promise<void> {
      shuttingDown = true
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
      // Drain queued-but-not-yet-dispatched tasks so callers know they were dropped.
      while (queue.length > 0) {
        const dropped = queue.shift() as Task
        ee.emit('task.error', dropped.id, {
          code: 'supervisor_shutdown',
          message: 'supervisor shut down before task was dispatched',
          tier: 'fatal',
        })
      }
      for (const s of slots) {
        if (s.state !== 'dead') s.handle.send({ type: 'shutdown' })
      }
      await Promise.all(slots.map((s) => s.handle.exited))
      log.info({ msg: 'supervisor shut down' })
    },
    on(event, cb): void {
      ee.on(event, cb as (...args: unknown[]) => void)
    },
  }
}
