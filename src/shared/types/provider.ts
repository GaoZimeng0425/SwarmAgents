import { z } from 'zod'

// The two built-in providers. Custom providers are referenced by a generated
// string id, so an "any provider" reference is just a string (builtin id or
// custom id) — see `active` / ProviderInjection.id.
export const BuiltinProviderId = z.enum(['anthropic', 'openai'])
export type BuiltinProviderId = z.infer<typeof BuiltinProviderId>

// Wire format a custom provider speaks. For built-ins the style is their id.
export const ApiStyle = z.enum(['anthropic', 'openai'])
export type ApiStyle = z.infer<typeof ApiStyle>

// Reasoning depth. Mirrors pi's ThinkingLevel plus 'off'. Which levels a given
// model actually supports is read from the pi-ai model registry, never hardcoded.
export const ModelThinkingLevel = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
export type ModelThinkingLevel = z.infer<typeof ModelThinkingLevel>

// Suggestion lists for the UI. Not enforced by the schema — users may type any
// provider-specific model id (e.g. "deepseek-chat"). First entry is the default.
export const ANTHROPIC_MODEL_SUGGESTIONS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const

export const OPENAI_MODEL_SUGGESTIONS = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'] as const

const ModelString = z.string().min(1).max(200)
const NameString = z.string().min(1).max(100)
const IdString = z.string().min(1).max(64)

// http/https URL. Empty string means "absent"; the service normalizes empty →
// null before persistence.
const BaseUrlString = z.string().url().max(2048)

// Capped at 50 so a misclick or stale UI can't balloon the on-disk file.
const CustomModelsList = z.array(ModelString).max(50)

// Context-window size in tokens. Mainly meaningful for custom models absent
// from pi-ai's registry. Capped well above any real model.
const ContextWindow = z.number().int().positive().max(10_000_000)

/** Default context window assumed when a model's real size is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

// Shared editable fields for any provider (built-in or custom).
const ProviderRowOnDisk = z.object({
  model: ModelString,
  apiKey: z.string().min(1),
  baseUrl: BaseUrlString.optional(),
  customModels: CustomModelsList.optional(),
  apiStyle: ApiStyle.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  contextWindow: ContextWindow.optional(),
})
export type ProviderRowOnDisk = z.infer<typeof ProviderRowOnDisk>

// A custom provider is a row plus identity (generated id + user-facing name)
// and a required apiStyle (its wire format has no implicit default).
const CustomProviderOnDisk = ProviderRowOnDisk.extend({
  id: IdString,
  name: NameString,
  apiStyle: ApiStyle,
})
export type CustomProviderOnDisk = z.infer<typeof CustomProviderOnDisk>

// On-disk shape (v2). NEVER crosses an IPC boundary to the renderer.
export const ProvidersStateOnDisk = z.object({
  version: z.literal(2),
  active: z.string().nullable(),
  builtins: z.object({
    anthropic: ProviderRowOnDisk.nullable().default(null),
    openai: ProviderRowOnDisk.nullable().default(null),
  }),
  custom: z.array(CustomProviderOnDisk).default([]),
})
export type ProvidersStateOnDisk = z.infer<typeof ProvidersStateOnDisk>

// ── Legacy v1 (3 fixed slots) — parsed only for migration ────────────────────
const ProvidersStateOnDiskV1 = z.object({
  version: z.literal(1),
  active: z.enum(['anthropic', 'openai', 'custom']).nullable(),
  providers: z.object({
    anthropic: ProviderRowOnDisk.nullable().default(null),
    openai: ProviderRowOnDisk.nullable().default(null),
    custom: ProviderRowOnDisk.nullable().default(null),
  }),
})
export type ProvidersStateOnDiskV1 = z.infer<typeof ProvidersStateOnDiskV1>

/**
 * Migrate a legacy v1 state to v2: built-in slots carry over; the single custom
 * slot (if any) becomes the first entry of the custom array with a generated id
 * and a default name. `genId` is injected so this module stays dependency-free.
 */
export function migrateV1ToV2(v1: ProvidersStateOnDiskV1, genId: () => string): ProvidersStateOnDisk {
  const legacyCustom = v1.providers.custom
  const custom: CustomProviderOnDisk[] = legacyCustom
    ? [{ ...legacyCustom, id: genId(), name: 'Custom', apiStyle: legacyCustom.apiStyle ?? 'openai' }]
    : []
  const active = v1.active === 'custom' ? (custom[0]?.id ?? null) : v1.active
  return {
    version: 2,
    active,
    builtins: { anthropic: v1.providers.anthropic, openai: v1.providers.openai },
    custom,
  }
}

/** Parse possibly-legacy persisted state. Returns null if it matches no schema. */
export function parsePersistedState(raw: unknown, genId: () => string): ProvidersStateOnDisk | null {
  const v2 = ProvidersStateOnDisk.safeParse(raw)
  if (v2.success) return v2.data
  const v1 = ProvidersStateOnDiskV1.safeParse(raw)
  if (v1.success) return migrateV1ToV2(v1.data, genId)
  return null
}

// ── Renderer-visible projection (apiKey replaced by hasKey) ───────────────────
const ProviderRowView = z.object({
  model: ModelString,
  hasKey: z.boolean(),
  supportsImages: z.boolean(),
  baseUrl: BaseUrlString.optional(),
  customModels: CustomModelsList.optional(),
  apiStyle: ApiStyle.optional(),
  thinkingLevels: z.array(ModelThinkingLevel),
  thinkingLevel: ModelThinkingLevel,
  contextWindow: ContextWindow.optional(),
})
export type ProviderRowView = z.infer<typeof ProviderRowView>

const CustomProviderView = ProviderRowView.extend({
  id: IdString,
  name: NameString,
})
export type CustomProviderView = z.infer<typeof CustomProviderView>

export const ProvidersStateView = z.object({
  active: z.string().nullable(),
  builtins: z.object({
    anthropic: ProviderRowView.nullable(),
    openai: ProviderRowView.nullable(),
  }),
  custom: z.array(CustomProviderView),
})
export type ProvidersStateView = z.infer<typeof ProvidersStateView>

/** Find a row in the view by id (builtin id or custom id). Renderer convenience. */
export function findProviderRowView(view: ProvidersStateView, id: string | null): ProviderRowView | null {
  if (!id) return null
  if (id === 'anthropic') return view.builtins.anthropic
  if (id === 'openai') return view.builtins.openai
  return view.custom.find((c) => c.id === id) ?? null
}

/** All configured providers (built-in slots that have a key + every custom), in display order. */
export function providerViewEntries(view: ProvidersStateView): { id: string; row: ProviderRowView }[] {
  const out: { id: string; row: ProviderRowView }[] = []
  if (view.builtins.anthropic) out.push({ id: 'anthropic', row: view.builtins.anthropic })
  if (view.builtins.openai) out.push({ id: 'openai', row: view.builtins.openai })
  for (const c of view.custom) out.push({ id: c.id, row: c })
  return out
}

// Injection payload travelling Main → Worker on task.assign. `id` is a builtin
// id ('anthropic'|'openai') or a custom provider id.
export const ProviderInjection = z.object({
  id: z.string(),
  model: ModelString,
  apiKey: z.string().min(1),
  baseUrl: BaseUrlString.optional(),
  apiStyle: ApiStyle.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  contextWindow: ContextWindow.optional(),
})
export type ProviderInjection = z.infer<typeof ProviderInjection>

export function defaultProvidersStateOnDisk(): ProvidersStateOnDisk {
  return {
    version: 2,
    active: null,
    builtins: { anthropic: null, openai: null },
    custom: [],
  }
}
