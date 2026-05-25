import { z } from 'zod'

export const ProviderId = z.enum(['anthropic', 'openai'])
export type ProviderId = z.infer<typeof ProviderId>

export const AnthropicModel = z.enum([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
])
export type AnthropicModel = z.infer<typeof AnthropicModel>

export const OpenAIModel = z.enum(['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'])
export type OpenAIModel = z.infer<typeof OpenAIModel>

// On-disk shape. NEVER crosses an IPC boundary to the renderer.
export const ProvidersStateOnDisk = z.object({
  version: z.literal(1),
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: z
      .object({ model: AnthropicModel, apiKey: z.string().min(1) })
      .nullable(),
    openai: z
      .object({ model: OpenAIModel, apiKey: z.string().min(1) })
      .nullable(),
  }),
})
export type ProvidersStateOnDisk = z.infer<typeof ProvidersStateOnDisk>

// Renderer-visible projection. apiKey replaced by hasKey.
export const ProvidersStateView = z.object({
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: z
      .object({ model: AnthropicModel, hasKey: z.boolean() })
      .nullable(),
    openai: z.object({ model: OpenAIModel, hasKey: z.boolean() }).nullable(),
  }),
})
export type ProvidersStateView = z.infer<typeof ProvidersStateView>

// Injection payload travelling Main → Worker on task.assign.
export const ProviderInjection = z.object({
  id: ProviderId,
  model: z.string().min(1),
  apiKey: z.string().min(1),
})
export type ProviderInjection = z.infer<typeof ProviderInjection>

export function defaultProvidersStateOnDisk(): ProvidersStateOnDisk {
  return {
    version: 1,
    active: null,
    providers: { anthropic: null, openai: null },
  }
}
