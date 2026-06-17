import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { ApiStyle, BuiltinProviderId, ModelThinkingLevel } from '@shared/types/provider'

// Which pi-ai registry to look a model up in: a built-in id, or 'custom' (whose
// real wire format comes from apiStyle).
type ModelLookupKind = BuiltinProviderId | 'custom'

// pi-ai's getModel is strictly typed per known provider; loosen it like agent-runner does.
const getModelLoose = getModel as unknown as (provider: KnownProvider, modelId: string) => Model<Api> | undefined

// Shown when a model isn't in the pi-ai registry (e.g. an unlisted custom model):
// offer 'off' plus the common three so the user can still pick a depth. The run
// re-clamps against the resolved model, so an unsupported pick degrades safely.
const UNKNOWN_MODEL_LEVELS: ModelThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** Default depth applied when the user hasn't chosen one for a reasoning model. */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'high'

function lookupModel(
  providerId: ModelLookupKind,
  apiStyle: ApiStyle | undefined,
  model: string
): Model<Api> | undefined {
  const lookup = (providerId === 'custom' ? (apiStyle ?? 'openai') : providerId) as KnownProvider
  return getModelLoose(lookup, model)
}

/** Pure decision: unknown capability is permissive (don't block models we can't introspect). */
export function modelSupportsImagesFromInput(input: readonly string[] | undefined): boolean {
  return input ? input.includes('image') : true
}

/** Look up a model's image capability from the pi-ai registry. */
export function modelSupportsImages(
  providerId: ModelLookupKind,
  apiStyle: ApiStyle | undefined,
  model: string
): boolean {
  return modelSupportsImagesFromInput(lookupModel(providerId, apiStyle, model)?.input)
}

/** Reasoning depths a model supports, from the pi-ai registry. Falls back for unlisted models. */
export function modelThinkingLevels(
  providerId: ModelLookupKind,
  apiStyle: ApiStyle | undefined,
  model: string
): ModelThinkingLevel[] {
  const m = lookupModel(providerId, apiStyle, model)
  if (!m) return [...UNKNOWN_MODEL_LEVELS]
  return getSupportedThinkingLevels(m) as ModelThinkingLevel[]
}

/** Resolve the effective depth to show/use: the stored choice (or the default), clamped to the model. */
export function effectiveThinkingLevel(
  providerId: ModelLookupKind,
  apiStyle: ApiStyle | undefined,
  model: string,
  stored: ModelThinkingLevel | undefined
): ModelThinkingLevel {
  const requested = stored ?? DEFAULT_THINKING_LEVEL
  const m = lookupModel(providerId, apiStyle, model)
  if (!m) {
    const levels = UNKNOWN_MODEL_LEVELS
    return levels.includes(requested) ? requested : (levels[levels.length - 1] ?? 'off')
  }
  return clampThinkingLevel(m, requested) as ModelThinkingLevel
}
