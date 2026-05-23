import type { Inbound, Outbound } from '@shared/types/ipc'

export type SendFn = (msg: Outbound) => void

/**
 * Foundation-plan worker handler. Echoes assigned tasks straight back as completions
 * so the supervisor + IPC layer can be verified end-to-end. Real agent loop arrives
 * in Plan 3.
 */
export function handleInbound(msg: Inbound, send: SendFn): void {
  switch (msg.type) {
    case 'task.assign':
      send({
        type: 'task.complete',
        taskId: msg.task.id,
        result: { summary: `echo: ${msg.task.goal}`, artifacts: [] },
      })
      return
    case 'task.cancel':
    case 'tool.result':
    case 'permission.decision':
    case 'shutdown':
      return
  }
}
