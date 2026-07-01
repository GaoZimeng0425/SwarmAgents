/**
 * Typed event bus for main-process pub/sub.
 *
 * Replaces raw EventEmitter with a singleton that publishes typed DomainEvent
 * values. Any main-process module can subscribe without a direct reference to
 * the supervisor.
 *
 * Usage:
 *   import { initEventBus, getEventBus } from '@shared/events'
 *   const bus = initEventBus()
 *   bus.subscribe('task.complete', (e) => { ... })
 *   bus.publish({ type: 'task.complete', taskId: '...', result, ts: Date.now() })
 */

import type { Risk, TaskEvent, TaskResult } from '@swarm/protocol'

// ── Domain events ────────────────────────────────────────────────────────

export type DomainEvent =
  | { type: 'task.created'; taskId: string; goal: string; parentId: string | null; ts: number }
  | { type: 'task.dispatched'; taskId: string; workerId: string; ts: number }
  | { type: 'task.progress'; taskId: string; event: TaskEvent; ts: number }
  | {
      type: 'task.tool_call'
      taskId: string
      workerId: string
      tool: string
      args: unknown
      ts: number
    }
  | {
      type: 'task.permission_request'
      taskId: string
      workerId: string
      actionId: string
      risk: Risk
      summary: string
      payload: unknown
      ts: number
    }
  | { type: 'task.complete'; taskId: string; result: TaskResult; ts: number }
  | { type: 'task.error'; taskId: string; error: unknown; ts: number }
  | {
      type: 'task.handoff.requested'
      parentTaskId: string
      newGoal: string
      suggestedTools?: string[]
      ts: number
    }
  | { type: 'task.handoff.spawned'; parentTaskId: string; childTaskId: string; ts: number }
  | {
      type: 'task.handoff.completed'
      parentTaskId: string
      childTaskId: string
      childSummary: string
      ts: number
    }

// ── Subscription handle ──────────────────────────────────────────────────

export type SubscriptionHandle = { unsubscribe: () => void }

// ── EventBus interface ───────────────────────────────────────────────────

export type EventBus = {
  publish(event: DomainEvent): void
  subscribe<T extends DomainEvent['type']>(
    eventType: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void
  ): SubscriptionHandle
  subscribeAll(handler: (event: DomainEvent) => void): SubscriptionHandle
  dispose(): void
}

// ── Implementation ───────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<Listener>>()
  const allListeners = new Set<Listener>()

  return {
    publish(event: DomainEvent): void {
      const typed = listeners.get(event.type)
      if (typed) {
        for (const fn of typed) fn(event)
      }
      for (const fn of allListeners) fn(event)
    },

    subscribe<T extends DomainEvent['type']>(
      eventType: T,
      handler: (event: Extract<DomainEvent, { type: T }>) => void
    ): SubscriptionHandle {
      let set = listeners.get(eventType)
      if (!set) {
        set = new Set()
        listeners.set(eventType, set)
      }
      const fn = handler as Listener
      set.add(fn)
      return {
        unsubscribe(): void {
          set!.delete(fn)
          if (set!.size === 0) listeners.delete(eventType)
        },
      }
    },

    subscribeAll(handler: (event: DomainEvent) => void): SubscriptionHandle {
      const fn = handler as Listener
      allListeners.add(fn)
      return {
        unsubscribe(): void {
          allListeners.delete(fn)
        },
      }
    },

    dispose(): void {
      listeners.clear()
      allListeners.clear()
    },
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

let globalBus: EventBus | null = null

export function initEventBus(): EventBus {
  if (!globalBus) globalBus = createEventBus()
  return globalBus
}

export function getEventBus(): EventBus | null {
  return globalBus
}

export function resetEventBus(): void {
  if (globalBus) {
    globalBus.dispose()
    globalBus = null
  }
}
