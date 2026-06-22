// src/service/actor-mailbox.ts
import type { ActorMessage } from '@shared/types/actor'

// Thrown by receive() when no message arrives within idleMs — the resident
// loop treats this as the signal to sleep (destroy the actor).
export class IdleTimeoutError extends Error {
  constructor() {
    super('mailbox idle timeout')
    this.name = 'IdleTimeoutError'
  }
}

export type Mailbox = {
  deliver(msg: ActorMessage): void
  receive(opts: { idleMs: number }): Promise<ActorMessage>
  size(): number
}

// In-memory FIFO inbox for one resident actor. One pending receiver at a time
// (the resident loop processes messages serially), so a single waiter slot.
export function createMailbox(): Mailbox {
  const queue: ActorMessage[] = []
  let waiter: { resolve: (m: ActorMessage) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout } | null = null

  return {
    deliver(msg) {
      if (waiter) {
        clearTimeout(waiter.timer)
        const w = waiter
        waiter = null
        w.resolve(msg)
        return
      }
      queue.push(msg)
    },
    receive({ idleMs }) {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      // Single-waiter contract: the resident loop awaits each receive serially.
      if (waiter) throw new Error('mailbox already has a pending receive')
      return new Promise<ActorMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiter) {
            waiter = null
            reject(new IdleTimeoutError())
          }
        }, idleMs)
        timer.unref?.()
        waiter = { resolve, reject, timer }
      })
    },
    size: () => queue.length,
  }
}
