import type { Risk } from '@swarm/protocol'
import { create } from 'zustand'

export type PermissionPrompt = {
  actionId: string
  sessionId: string
  taskId: string
  workerId: string | null
  risk: Risk
  summary: string
  payload: unknown
}

type PermissionStore = {
  queue: PermissionPrompt[]
  push: (p: PermissionPrompt) => void
  remove: (actionId: string) => void
}

export const usePermissionStore = create<PermissionStore>((set) => ({
  queue: [],
  push: (p) => set((s) => (s.queue.some((x) => x.actionId === p.actionId) ? s : { queue: [...s.queue, p] })),
  remove: (id) => set((s) => ({ queue: s.queue.filter((x) => x.actionId !== id) })),
}))
