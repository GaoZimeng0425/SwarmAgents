import type { Inbound, Outbound } from '@shared/types/ipc'

import { simulateThinking } from './simulator'

export type SendFn = (msg: Outbound) => void

/**
 * Worker inbound dispatcher. Phase A: kicks off a simulated agent loop on
 * task.assign. Phase B will replace the simulator with a Vercel-AI-SDK loop.
 */
export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      // Fire and forget — the simulator emits multiple events over time and
      // the supervisor/test observes them via send().
      void simulateThinking(msg.task, send)
      return
    case 'task.cancel':
    case 'tool.result':
    case 'permission.decision':
    case 'shutdown':
      return
  }
}
