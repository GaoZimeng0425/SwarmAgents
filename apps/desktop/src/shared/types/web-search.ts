import { z } from 'zod'

// 'auto' = pick the first available backend by key presence (tavily → brave →
// searxng → duckduckgo). The other ids force that specific backend.
export const WebSearchProviderId = z.enum(['auto', 'tavily', 'brave', 'searxng', 'duckduckgo'])
export type WebSearchProviderId = z.infer<typeof WebSearchProviderId>

// On-disk shape. `keys` hold secrets — encrypted at rest via safeStorage,
// NEVER sent to the renderer (see WebSearchConfigView). searxngUrl is not a
// secret but lives here for one round-trip.
export const WebSearchConfigOnDisk = z.object({
  version: z.literal(1),
  provider: WebSearchProviderId.default('auto'),
  keys: z
    .object({
      tavily: z.string().optional(),
      brave: z.string().optional(),
    })
    .default({}),
  searxngUrl: z.string().optional(),
})
export type WebSearchConfigOnDisk = z.infer<typeof WebSearchConfigOnDisk>

// Renderer-visible projection. Keys replaced by hasKey booleans.
export const WebSearchConfigView = z.object({
  provider: WebSearchProviderId,
  hasTavilyKey: z.boolean(),
  hasBraveKey: z.boolean(),
  searxngUrl: z.string().optional(),
})
export type WebSearchConfigView = z.infer<typeof WebSearchConfigView>

// Injection payload Main → service. Carries the secrets; the service holds it
// in memory and the web_search tool resolves it (falling back to env) per call.
export const WebSearchInjection = z.object({
  provider: WebSearchProviderId,
  tavilyKey: z.string().optional(),
  braveKey: z.string().optional(),
  searxngUrl: z.string().optional(),
})
export type WebSearchInjection = z.infer<typeof WebSearchInjection>

export function defaultWebSearchConfigOnDisk(): WebSearchConfigOnDisk {
  return { version: 1, provider: 'auto', keys: {} }
}
