import { createLogger } from '@shared/logger'

const log = createLogger({ process: 'service' }).child({ component: 'reply' })

type PendingReply = { resolve: (payload: string) => void; timer: NodeJS.Timeout }

export type ReplyRegistry = {
  // Register a one-shot wait for an rpc reply. Resolves to the reply payload,
  // or to '' on timeout (mirrors plan A: an rpc that gets no reply returns '').
  awaitReply(correlationId: string, timeoutMs: number): Promise<string>
  // Deliver a reply. No-op if no one is waiting (the caller was destroyed).
  resolve(correlationId: string, payload: string): void
}

export function createReplyRegistry(): ReplyRegistry {
  const pending = new Map<string, PendingReply>()

  return {
    awaitReply(correlationId, timeoutMs) {
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(correlationId)) {
            log.warn({ msg: 'rpc reply timed out', correlationId, timeoutMs })
            resolve('')
          }
        }, timeoutMs)
        timer.unref?.()
        pending.set(correlationId, { resolve, timer })
      })
    },

    resolve(correlationId, payload) {
      const p = pending.get(correlationId)
      if (!p) {
        log.warn({ msg: 'rpc reply has no waiter (caller gone)', correlationId })
        return
      }
      clearTimeout(p.timer)
      pending.delete(correlationId)
      p.resolve(payload)
    },
  }
}
