import type { Inbound, Outbound } from '@shared/types/ipc'

import { runPiAgent } from './pi-agent'
import { createPermissionClient, type PermissionClient } from './permission-client'
import { simulateThinking } from './simulator'

export type SendFn = (msg: Outbound) => void

const useSimulator = (): boolean => process.env.SWARM_USE_SIMULATOR === '1'

let permissionClient: PermissionClient | null = null

function getPermissionClient(send: SendFn): PermissionClient {
  if (!permissionClient) permissionClient = createPermissionClient(send)
  return permissionClient
}

export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      if (useSimulator()) {
        void simulateThinking(msg.task, send)
        return
      }
      void runPiAgent(msg.task, {
        send,
        permissionClient: getPermissionClient(send),
        provider: msg.provider,
      })
      return
    case 'permission.decision':
      getPermissionClient(send).resolve(msg.actionId, msg.decision)
      return
    case 'task.cancel':
    case 'tool.result':
    case 'shutdown':
      return
  }
}
