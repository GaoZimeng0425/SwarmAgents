// src/shared/types/calendar.ts
import { z } from 'zod'

// OAuth client credentials the user pastes into Settings (same shape as Gmail).
export const CalendarClientCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})
export type CalendarClientCreds = z.infer<typeof CalendarClientCredsSchema>

// Tokens obtained from the OAuth code exchange. Stored encrypted.
export const CalendarTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().int(), // epoch ms
})
export type CalendarTokens = z.infer<typeof CalendarTokensSchema>

// On-disk config (encrypted via safeStorage).
export const CalendarConfigOnDisk = z.object({
  clientCreds: CalendarClientCredsSchema.nullable(),
  tokens: CalendarTokensSchema.nullable(),
  accountEmail: z.string().nullable(),
})
export type CalendarConfigOnDisk = z.infer<typeof CalendarConfigOnDisk>

export function defaultCalendarConfigOnDisk(): CalendarConfigOnDisk {
  return { clientCreds: null, tokens: null, accountEmail: null }
}

// Renderer-facing view: no secrets.
export const CalendarConfigViewSchema = z.object({
  hasClientCreds: z.boolean(),
  loggedIn: z.boolean(),
  accountEmail: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  googleEventCount: z.number().int().nullable(),
  localEventCount: z.number().int().nullable(),
  syncError: z.string().nullable(),
})
export type CalendarConfigView = z.infer<typeof CalendarConfigViewSchema>

// Unified event shape (cache row + tool result + view item).
export const CalendarEventSchema = z.object({
  id: z.string(),
  source: z.enum(['google', 'local']),
  sourceId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  allDay: z.boolean(),
  attendees: z.array(z.string()),
  calendarId: z.string().nullable(),
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>
