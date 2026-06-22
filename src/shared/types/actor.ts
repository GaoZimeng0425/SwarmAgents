// src/shared/types/actor.ts
import { z } from 'zod'

export const MessageKindSchema = z.enum(['send', 'rpc'])
export type MessageKind = z.infer<typeof MessageKindSchema>

// A long-lived addressable identity. One Actor maps to many Tasks (activations).
export type Actor = {
  address: string // ULID, or a user/agent-chosen readable name
  agentDefId: string
  sessionId: string | null
  name: string | null
  state: string | null // JSON {v,messages}: cross-dormancy conversation memory (phase 3)
  lastTaskId: string | null
  createdAt: number
  updatedAt: number
}

// A persisted inbox entry addressed to an Actor.
export type ActorMessage = {
  id: string
  toAddr: string
  fromAddr: string | null
  kind: MessageKind
  correlationId: string | null // links an rpc reply back to its caller
  payload: string // JSON
  consumed: boolean
  retries: number
  dead: boolean
  ts: number
}
