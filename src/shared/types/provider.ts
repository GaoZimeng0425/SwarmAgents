import { z } from 'zod'

// The two providers pi-ai has a built-in model catalog for. A provider whose
// `registry` is one of these can be looked up in pi-ai (real capabilities,
// default baseUrl); a provider with no `registry` is a custom endpoint known
// only by its wire format (apiStyle) + baseUrl.
export const BuiltinProviderId = z.enum(['anthropic', 'openai'])
export type BuiltinProviderId = z.infer<typeof BuiltinProviderId>

// Wire format a provider speaks. For built-ins this equals their registry id.
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

/** Max models in a single provider's list. */
export const MAX_MODELS = 50

// Context-window size in tokens. Mainly meaningful for custom models absent
// from pi-ai's registry. Capped well above any real model.
const ContextWindow = z.number().int().positive().max(10_000_000)

/** Default context window assumed when a model's real size is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

// Per-model pricing in USD per 1M tokens (same units as pi-ai Model.cost).
export const ModelPricing = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cacheReadPerM: z.number().nonnegative().optional(),
  cacheWritePerM: z.number().nonnegative().optional(),
})
export type ModelPricing = z.infer<typeof ModelPricing>

// Per-model metadata for custom providers. Built-ins read real capabilities
// from the pi-ai registry and never populate this.
export const ModelMeta = z.object({
  contextWindow: ContextWindow.optional(),
  pricing: ModelPricing.optional(),
})
export type ModelMeta = z.infer<typeof ModelMeta>

// ── Built-in identity, in one place ───────────────────────────────────────────
// Everything special about a built-in provider lives here: its display name, its
// pi-ai registry key, its wire format, and its suggested models. The service
// materializes a built-in provider row from this on first use; nothing else in
// the codebase branches on a provider id.
export const BUILTIN_DEFS = {
  anthropic: {
    name: 'Anthropic',
    registry: 'anthropic',
    apiStyle: 'anthropic',
    suggestions: ANTHROPIC_MODEL_SUGGESTIONS,
  },
  openai: {
    name: 'OpenAI',
    registry: 'openai',
    apiStyle: 'openai',
    suggestions: OPENAI_MODEL_SUGGESTIONS,
  },
} as const satisfies Record<
  BuiltinProviderId,
  { name: string; registry: BuiltinProviderId; apiStyle: ApiStyle; suggestions: readonly string[] }
>

export const BUILTIN_IDS = ['anthropic', 'openai'] as const

export function isBuiltinId(id: string): id is BuiltinProviderId {
  return id === 'anthropic' || id === 'openai'
}

/** Suggested models for a provider id (built-in suggestions, else none). */
export function modelSuggestionsFor(id: string): readonly string[] {
  return isBuiltinId(id) ? BUILTIN_DEFS[id].suggestions : []
}

// ── v3 legacy provider (provider-level contextWindow) — parsed only for migration ──
const ProviderV3 = z.object({
  id: IdString,
  name: NameString,
  registry: BuiltinProviderId.optional(),
  apiStyle: ApiStyle,
  apiKey: z.string().min(1),
  models: z.array(ModelString).min(1).max(MAX_MODELS),
  model: ModelString,
  baseUrl: BaseUrlString.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  contextWindow: ContextWindow.optional(),
})
type ProviderV3 = z.infer<typeof ProviderV3>

const ProvidersStateOnDiskV3 = z.object({
  version: z.literal(3),
  active: z.string().nullable(),
  providers: z.array(ProviderV3).default([]),
})
type ProvidersStateOnDiskV3 = z.infer<typeof ProvidersStateOnDiskV3>

// ── On-disk shape (v4): per-model metadata replaces provider-level contextWindow ──
export const Provider = z.object({
  id: IdString,
  name: NameString,
  registry: BuiltinProviderId.optional(),
  apiStyle: ApiStyle,
  apiKey: z.string().min(1),
  models: z.array(ModelString).min(1).max(MAX_MODELS),
  model: ModelString,
  baseUrl: BaseUrlString.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  modelMeta: z.record(ModelString, ModelMeta).optional(),
  // Ordered ids of providers to fall back to when this provider's request fails
  // (transport error / bad key / quota). Resolved into the injection's
  // `fallbackProviders` chain at injection time. Optional ⇒ no fallback.
  fallbackProviderIds: z.array(IdString).optional(),
})
export type Provider = z.infer<typeof Provider>

export const ProvidersStateOnDisk = z.object({
  version: z.literal(4),
  active: z.string().nullable(),
  providers: z.array(Provider).default([]),
})
export type ProvidersStateOnDisk = z.infer<typeof ProvidersStateOnDisk>

// ── Legacy schemas — parsed only for migration ────────────────────────────────
const ProviderRowOnDiskV2 = z.object({
  model: ModelString,
  apiKey: z.string().min(1),
  baseUrl: BaseUrlString.optional(),
  customModels: z.array(ModelString).max(MAX_MODELS).optional(),
  apiStyle: ApiStyle.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  contextWindow: ContextWindow.optional(),
})
const CustomProviderOnDiskV2 = ProviderRowOnDiskV2.extend({
  id: IdString,
  name: NameString,
  apiStyle: ApiStyle,
})
const ProvidersStateOnDiskV2 = z.object({
  version: z.literal(2),
  active: z.string().nullable(),
  builtins: z.object({
    anthropic: ProviderRowOnDiskV2.nullable().default(null),
    openai: ProviderRowOnDiskV2.nullable().default(null),
  }),
  custom: z.array(CustomProviderOnDiskV2).default([]),
})
type ProvidersStateOnDiskV2 = z.infer<typeof ProvidersStateOnDiskV2>

const ProvidersStateOnDiskV1 = z.object({
  version: z.literal(1),
  active: z.enum(['anthropic', 'openai', 'custom']).nullable(),
  providers: z.object({
    anthropic: ProviderRowOnDiskV2.nullable().default(null),
    openai: ProviderRowOnDiskV2.nullable().default(null),
    custom: ProviderRowOnDiskV2.nullable().default(null),
  }),
})
type ProvidersStateOnDiskV1 = z.infer<typeof ProvidersStateOnDiskV1>

// Build a v3 provider from a legacy row, merging the selected model + extras
// into one capped list with the selected model first.
function rowToProvider(
  id: string,
  name: string,
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  row: z.infer<typeof ProviderRowOnDiskV2>
): ProviderV3 {
  const models = [...new Set([row.model, ...(row.customModels ?? [])])].slice(0, MAX_MODELS)
  return {
    id,
    name,
    ...(registry ? { registry } : {}),
    apiStyle,
    apiKey: row.apiKey,
    models,
    model: row.model,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
  }
}

function migrateV1ToV2(v1: ProvidersStateOnDiskV1, genId: () => string): ProvidersStateOnDiskV2 {
  const legacyCustom = v1.providers.custom
  const custom = legacyCustom
    ? [{ ...legacyCustom, id: genId(), name: 'Custom', apiStyle: legacyCustom.apiStyle ?? ('openai' as ApiStyle) }]
    : []
  const active = v1.active === 'custom' ? (custom[0]?.id ?? null) : v1.active
  return {
    version: 2,
    active,
    builtins: { anthropic: v1.providers.anthropic, openai: v1.providers.openai },
    custom,
  }
}

function migrateV2ToV3(v2: ProvidersStateOnDiskV2): ProvidersStateOnDiskV3 {
  const providers: ProviderV3[] = []
  for (const bid of BUILTIN_IDS) {
    const row = v2.builtins[bid]
    if (row) {
      const def = BUILTIN_DEFS[bid]
      providers.push(rowToProvider(bid, def.name, def.registry, row.apiStyle ?? def.apiStyle, row))
    }
  }
  for (const c of v2.custom) {
    providers.push(rowToProvider(c.id, c.name, undefined, c.apiStyle, c))
  }
  return { version: 3, active: v2.active, providers }
}

function migrateV3ToV4(v3: ProvidersStateOnDiskV3): ProvidersStateOnDisk {
  const providers: Provider[] = v3.providers.map((p) => {
    const { contextWindow, ...rest } = p
    // Built-ins read their real window from pi-ai; only custom rows carried a
    // meaningful provider-level override worth preserving per-model.
    if (rest.registry || contextWindow == null) return rest
    return { ...rest, modelMeta: { [rest.model]: { contextWindow } } }
  })
  return { version: 4, active: v3.active, providers }
}

/** Parse possibly-legacy persisted state, migrating v1/v2/v3 forward. Null if no schema matches. */
export function parsePersistedState(raw: unknown, genId: () => string): ProvidersStateOnDisk | null {
  const v4 = ProvidersStateOnDisk.safeParse(raw)
  if (v4.success) return v4.data
  const v3 = ProvidersStateOnDiskV3.safeParse(raw)
  if (v3.success) return migrateV3ToV4(v3.data)
  const v2 = ProvidersStateOnDiskV2.safeParse(raw)
  if (v2.success) return migrateV3ToV4(migrateV2ToV3(v2.data))
  const v1 = ProvidersStateOnDiskV1.safeParse(raw)
  if (v1.success) return migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(v1.data, genId)))
  return null
}

// ── Renderer-visible projection (apiKey replaced by hasKey) ───────────────────
export const ProviderView = z.object({
  id: IdString,
  name: NameString,
  registry: BuiltinProviderId.optional(),
  apiStyle: ApiStyle,
  hasKey: z.boolean(),
  supportsImages: z.boolean(),
  models: z.array(ModelString).min(1).max(MAX_MODELS),
  model: ModelString,
  baseUrl: BaseUrlString.optional(),
  thinkingLevels: z.array(ModelThinkingLevel),
  thinkingLevel: ModelThinkingLevel,
  modelMeta: z.record(ModelString, ModelMeta).optional(),
})
export type ProviderView = z.infer<typeof ProviderView>

export const ProvidersStateView = z.object({
  active: z.string().nullable(),
  providers: z.array(ProviderView),
})
export type ProvidersStateView = z.infer<typeof ProvidersStateView>

/** Find a provider in the view by id. Renderer convenience. */
export function providerViewById(view: ProvidersStateView, id: string | null): ProviderView | null {
  if (!id) return null
  return view.providers.find((p) => p.id === id) ?? null
}

// Injection payload travelling Main → Worker on task.assign. `registry` (if
// present) selects the pi-ai catalog; `apiStyle` is always the wire format.
const ProviderInjectionFields = {
  id: z.string(),
  registry: BuiltinProviderId.optional(),
  apiStyle: ApiStyle,
  model: ModelString,
  apiKey: z.string().min(1),
  baseUrl: BaseUrlString.optional(),
  thinkingLevel: ModelThinkingLevel.optional(),
  contextWindow: ContextWindow.optional(),
  pricing: ModelPricing.optional(),
}
export const ProviderInjection = z.object({
  ...ProviderInjectionFields,
  // Resolved fallback chain (from the provider's `fallbackProviderIds`). One
  // level deep — fallbacks carry no nested fallbacks — so the agent-runner walks
  // a flat model chain. Resolved in main/providers (where every provider's key
  // lives) and carried across IPC on the active injection.
  fallbackProviders: z.array(z.object(ProviderInjectionFields)).optional(),
})
export type ProviderInjection = z.infer<typeof ProviderInjection>

export function defaultProvidersStateOnDisk(): ProvidersStateOnDisk {
  return { version: 4, active: null, providers: [] }
}
