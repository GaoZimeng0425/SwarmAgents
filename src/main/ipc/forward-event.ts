import type { UIEvent } from '@shared/types/ui'

/**
 * The service emits SSE frames whose *event name* is the discriminator the
 * renderer's `UIEvent` union keys on (`kind`). The SSE wire format keeps that
 * name in the `event:` line and the payload — minus the discriminator — in the
 * `data:` line (see service/sse.ts). When forwarding to the renderer we must
 * re-attach the name as `kind`, otherwise every event reaches `applyEvent`
 * with `kind === undefined` and degrades into an "(unknown task)" stub that
 * never leaves the `running` state.
 */
export function toRendererEvent(event: string, data: unknown): UIEvent {
  const base = data && typeof data === 'object' ? (data as Record<string, unknown>) : { data }
  return { kind: event, ...base } as UIEvent
}
