// Claude-Code-style hooks config: maps a Claude event name (e.g.
// "Notification", "PermissionRequest", "Stop") to matcher blocks, each
// carrying command hooks the service spawns when that event fires. The
// mapping from Claude names to internal run.* kinds lives in the service's
// hook dispatcher; this schema is intentionally name-agnostic (any string
// key is accepted) so new event names need no schema change.
import { z } from 'zod'

export const HookEntrySchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
})
export type HookEntry = z.infer<typeof HookEntrySchema>

export const HookMatcherSchema = z.object({
  // Reserved for future per-event filtering (tool name, etc.). Currently
  // empty/absent means "match all"; non-empty is accepted but does not yet
  // filter — see the dispatcher's TODO.
  matcher: z.string().default(''),
  hooks: z.array(HookEntrySchema).default([]),
})
export type HookMatcher = z.infer<typeof HookMatcherSchema>

/** Top-level hooks.json: a map of Claude event name → matcher blocks. */
export const HooksFileSchema = z.record(z.string(), z.array(HookMatcherSchema)).default({})
export type HooksFile = z.infer<typeof HooksFileSchema>
