// src/shared/types/gmail.ts
import { z } from 'zod'

// OAuth client credentials the user pastes into Settings.
export const GmailClientCredsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})
export type GmailClientCreds = z.infer<typeof GmailClientCredsSchema>

// Tokens obtained from the OAuth code exchange. Stored encrypted.
export const GmailTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(), // gmail.readonly grants offline access
  expiresAt: z.number().int(), // epoch ms
})
export type GmailTokens = z.infer<typeof GmailTokensSchema>

// On-disk config (encrypted via safeStorage).
export const GmailConfigOnDisk = z.object({
  clientCreds: GmailClientCredsSchema.nullable(),
  tokens: GmailTokensSchema.nullable(),
  accountEmail: z.string().nullable(),
})
export type GmailConfigOnDisk = z.infer<typeof GmailConfigOnDisk>

export function defaultGmailConfigOnDisk(): GmailConfigOnDisk {
  return { clientCreds: null, tokens: null, accountEmail: null }
}

// Renderer-facing view: no secrets.
export const GmailConfigViewSchema = z.object({
  hasClientCreds: z.boolean(),
  loggedIn: z.boolean(),
  accountEmail: z.string().nullable(),
  lastSyncAt: z.number().int().nullable(),
  messageCount: z.number().int().nullable(),
  syncError: z.string().nullable(),
})
export type GmailConfigView = z.infer<typeof GmailConfigViewSchema>

// Cache row shapes (also the tool result shapes).
export const GmailThreadSchema = z.object({
  id: z.string(),
  snippet: z.string(),
  fromAddr: z.string(),
  subject: z.string(),
  lastDateMs: z.number().int(),
  labelIds: z.array(z.string()),
  unread: z.boolean(),
})
export type GmailThread = z.infer<typeof GmailThreadSchema>

export const GmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  fromAddr: z.string(),
  toAddrs: z.array(z.string()),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string(),
  dateMs: z.number().int(),
  labelIds: z.array(z.string()),
})
export type GmailMessage = z.infer<typeof GmailMessageSchema>
