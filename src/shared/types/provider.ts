import { z } from 'zod'

export const ProviderId = z.enum(['anthropic', 'openai', 'custom'])
export type ProviderId = z.infer<typeof ProviderId>

// Wire format the custom provider speaks. Reuses the IDs of the two built-in
// styles. Ignored for the anthropic/openai slots (whose style is implicit).
export const ApiStyle = z.enum(['anthropic', 'openai'])
export type ApiStyle = z.infer<typeof ApiStyle>

// Suggestion lists for the UI. Not enforced by the schema — once we support
// custom baseUrls, users may legitimately type any provider-specific model id
// (e.g. "deepseek-chat", "qwen-max"). First entry is the default.
export const ANTHROPIC_MODEL_SUGGESTIONS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const

export const OPENAI_MODEL_SUGGESTIONS = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'] as const

const ModelString = z.string().min(1).max(200)

// http/https URL. We accept the empty string for "absent" so the renderer can
// blank out the field and call setBaseUrl('') instead of inventing a separate
// clear method. Service normalizes empty → null before persistence.
const BaseUrlString = z.string().url().max(2048)

// Capped at 50 so a misclick or stale UI can't balloon the on-disk file. Far
// above any realistic usage.
const CustomModelsList = z.array(ModelString).max(50)

const ProviderRowOnDisk = z.object({
  model: ModelString,
  apiKey: z.string().min(1),
  baseUrl: BaseUrlString.optional(),
  customModels: CustomModelsList.optional(),
  // Only meaningful on the `custom` slot; ignored otherwise.
  apiStyle: ApiStyle.optional(),
})

// On-disk shape. NEVER crosses an IPC boundary to the renderer.
// `.default(null)` on each slot keeps legacy state files (which didn't include
// the `custom` slot) parseable when a new client opens them.
export const ProvidersStateOnDisk = z.object({
  version: z.literal(1),
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: ProviderRowOnDisk.nullable().default(null),
    openai: ProviderRowOnDisk.nullable().default(null),
    custom: ProviderRowOnDisk.nullable().default(null),
  }),
})
export type ProvidersStateOnDisk = z.infer<typeof ProvidersStateOnDisk>

const ProviderRowView = z.object({
  model: ModelString,
  hasKey: z.boolean(),
  baseUrl: BaseUrlString.optional(),
  customModels: CustomModelsList.optional(),
  apiStyle: ApiStyle.optional(),
})

// Renderer-visible projection. apiKey replaced by hasKey.
export const ProvidersStateView = z.object({
  active: ProviderId.nullable(),
  providers: z.object({
    anthropic: ProviderRowView.nullable(),
    openai: ProviderRowView.nullable(),
    custom: ProviderRowView.nullable(),
  }),
})
export type ProvidersStateView = z.infer<typeof ProvidersStateView>

// Injection payload travelling Main → Worker on task.assign.
export const ProviderInjection = z.object({
  id: ProviderId,
  model: ModelString,
  apiKey: z.string().min(1),
  baseUrl: BaseUrlString.optional(),
  apiStyle: ApiStyle.optional(),
})
export type ProviderInjection = z.infer<typeof ProviderInjection>

export function defaultProvidersStateOnDisk(): ProvidersStateOnDisk {
  return {
    version: 1,
    active: null,
    providers: { anthropic: null, openai: null, custom: null },
  }
}
