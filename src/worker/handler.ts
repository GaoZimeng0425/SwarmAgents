import type { Inbound, Outbound } from '@shared/types/ipc'

import { runAgent } from './agent'
import { simulateThinking } from './simulator'

export type SendFn = (msg: Outbound) => void

const useSimulator =
  process.env.SWARM_USE_SIMULATOR === '1' || !process.env.ANTHROPIC_API_KEY

/**
 * Worker inbound dispatcher.
 *
 * Routes task.assign to either the real Anthropic-backed agent loop (when
 * ANTHROPIC_API_KEY is set and SWARM_USE_SIMULATOR is not 1) or the
 * deterministic simulator (fallback so the demo runs without a key).
 *
 * Other Inbound kinds are placeholders for later plans.
 */
export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      if (useSimulator) {
        void simulateThinking(msg.task, send)
      } else {
        void runAgent(msg.task, send)
      }
      return
    case 'task.cancel':
    case 'tool.result':
    case 'permission.decision':
    case 'shutdown':
      return
  }
}
