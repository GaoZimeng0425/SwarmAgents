import type { Risk } from '@shared/types/ipc'

export type PermissionRequest = {
  taskId: string
  actionId: string
  risk: Risk
  summary: string
  payload: unknown
}

export type PermissionDecision = 'grant' | 'deny' | 'skip'

export type PromptHandler = (req: PermissionRequest) => Promise<PermissionDecision>

export type GateConfig = {
  defaultPolicy: 'allow-all' | 'prompt-on-medium-and-high' | 'deny-all'
}

export type PermissionGate = {
  evaluate(req: PermissionRequest): Promise<PermissionDecision>
  setPromptHandler(h: PromptHandler): void
}

export function createPermissionGate(cfg: GateConfig): PermissionGate {
  let promptHandler: PromptHandler | null = null

  return {
    setPromptHandler(h) {
      promptHandler = h
    },
    async evaluate(req) {
      if (cfg.defaultPolicy === 'allow-all') return 'grant'
      if (cfg.defaultPolicy === 'deny-all') return 'deny'
      // prompt-on-medium-and-high
      if (req.risk === 'low') return 'grant'
      if (!promptHandler) throw new Error('no prompt handler registered for non-low-risk request')
      return promptHandler(req)
    },
  }
}
