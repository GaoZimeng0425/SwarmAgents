import type { AgentMessage } from '@earendil-works/pi-agent-core'

// Cross-dormancy actor memory: the addressable actor's conversation history is
// externalized to actors.state as a versioned JSON blob, replayed on activation
// and persisted each turn. The version tag lets a future pi message-format
// change be detected on replay and discarded gracefully rather than crashing
// deserialization.
export const ACTOR_STATE_VERSION = 1

type ActorStateBlob = { v: number; messages: AgentMessage[] }

export function encodeActorState(messages: AgentMessage[]): string {
  return JSON.stringify({ v: ACTOR_STATE_VERSION, messages } satisfies ActorStateBlob)
}

// Never throws: a null/corrupt/version-mismatched blob yields an empty history
// so the actor restarts clean (caller logs a warn). A clean restart beats a
// crash on replay.
export function decodeActorState(raw: string | null): AgentMessage[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<ActorStateBlob>
    if (parsed.v !== ACTOR_STATE_VERSION || !Array.isArray(parsed.messages)) return []
    return parsed.messages
  } catch {
    return []
  }
}
