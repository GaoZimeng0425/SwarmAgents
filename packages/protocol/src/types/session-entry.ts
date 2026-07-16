import { z } from 'zod'

/**
 * Wire/persistence entry model. Structurally mirrors pi-agent-core 0.80.6
 * SessionTreeEntry (harness/types.d.ts:230-293) WITHOUT importing it, so web
 * and mobile clients stay free of the pi dependency. The service asserts
 * assignability in a type test (see service sqlite-storage.test.ts).
 */
const base = { id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.string() }

// AgentMessage payloads are provider-shaped and open-ended; the store treats
// them as opaque JSON. Validation of message internals belongs to pi.
const MessagePayload = z.looseObject({ role: z.string() })

export const SessionEntrySchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message'), message: MessagePayload }),
  z.object({ ...base, type: z.literal('model_change'), provider: z.string(), modelId: z.string() }),
  z.object({ ...base, type: z.literal('thinking_level_change'), thinkingLevel: z.string() }),
  z.object({
    ...base,
    type: z.literal('compaction'),
    summary: z.string(),
    firstKeptEntryId: z.string(),
    tokensBefore: z.number(),
    details: z.unknown().optional(),
    fromHook: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal('custom'), customType: z.string(), data: z.unknown().optional() }),
  z.object({
    ...base,
    type: z.literal('custom_message'),
    customType: z.string(),
    content: z.unknown(),
    details: z.unknown().optional(),
    display: z.boolean(),
  }),
])
export type SessionEntry = z.infer<typeof SessionEntrySchema>
export type MessageEntry = Extract<SessionEntry, { type: 'message' }>
export type CustomEntry = Extract<SessionEntry, { type: 'custom' }>

/** A persisted entry with its sqlite AUTOINCREMENT id — the order key and replay cursor. */
export type EntryRow = { rowId: number; entry: SessionEntry }
