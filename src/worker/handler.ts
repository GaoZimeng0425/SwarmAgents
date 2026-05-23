import type { Inbound, Outbound } from '@shared/types/ipc'

import { createPermissionClient, type PermissionClient } from './permission-client'

export type SendFn = (msg: Outbound) => void

let permissionClient: PermissionClient | null = null

function getPermissionClient(send: SendFn): PermissionClient {
  if (!permissionClient) permissionClient = createPermissionClient(send)
  return permissionClient
}

export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      // Stub during pi migration; Task D7 routes to runPiAgent / simulator.
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
