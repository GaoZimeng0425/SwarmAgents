import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { getBuiltinModel as getModel } from '@earendil-works/pi-ai/providers/all'
import type { ApiStyle, BuiltinProviderId, ModelThinkingLevel } from '@swarm/protocol'
import { reasoningSpecFor } from '@swarm/shared'

// pi-ai's getModel is strictly typed per known provider; loosen it like agent-runner does.
const getModelLoose = getModel as unknown as (provider: KnownProvider, modelId: string) => Model<Api> | undefined

// Shown when a model isn't in the pi-ai registry (e.g. an unlisted custom model):
// offer 'off' plus the common three so the user can still pick a depth. The run
// re-clamps against the resolved model, so an unsupported pick degrades safely.
const UNKNOWN_MODEL_LEVELS: ModelThinkingLevel[] = ['off', 'low', 'medium', 'high']

/** Default depth applied when the user hasn't chosen one for a reasoning model. */
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'high'

// Which pi-ai catalog to consult: the provider's `registry` if it has one, else
// its wire style (a custom endpoint pi-ai doesn't natively know).
function lookupModel(
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  model: string
): Model<Api> | undefined {
  return getModelLoose((registry ?? apiStyle) as KnownProvider, model)
}

// A spec'd custom model (GLM/DeepSeek/MiMo) isn't in the pi-ai registry, but its
// reasoning spec carries exactly what getSupportedThinkingLevels/clampThinkingLevel
// read (`reasoning` + `thinkingLevelMap`). Synthesize a minimal model so the UI
// derives the same real depths pi-ai would for a built-in reasoning model.
function specModel(model: string): Model<Api> | undefined {
  const spec = reasoningSpecFor(model)
  if (!spec) return undefined
  return { reasoning: spec.reasoning, thinkingLevelMap: spec.thinkingLevelMap } as Model<Api>
}

// Registry model first, then a spec-synthesized one for known custom families.
function resolveModelCaps(
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  model: string
): Model<Api> | undefined {
  return lookupModel(registry, apiStyle, model) ?? specModel(model)
}

/** Pure decision: unknown capability is permissive (don't block models we can't introspect). */
export function modelSupportsImagesFromInput(input: readonly string[] | undefined): boolean {
  return input ? input.includes('image') : true
}

/** Look up a model's image capability from the pi-ai registry. */
export function modelSupportsImages(
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  model: string
): boolean {
  return modelSupportsImagesFromInput(lookupModel(registry, apiStyle, model)?.input)
}

/** Reasoning depths a model supports, from the pi-ai registry. Falls back for unlisted models. */
export function modelThinkingLevels(
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  model: string
): ModelThinkingLevel[] {
  const m = resolveModelCaps(registry, apiStyle, model)
  if (!m) return [...UNKNOWN_MODEL_LEVELS]
  return getSupportedThinkingLevels(m) as ModelThinkingLevel[]
}

/** Resolve the effective depth to show/use: the stored choice (or the default), clamped to the model. */
export function effectiveThinkingLevel(
  registry: BuiltinProviderId | undefined,
  apiStyle: ApiStyle,
  model: string,
  stored: ModelThinkingLevel | undefined
): ModelThinkingLevel {
  const requested = stored ?? DEFAULT_THINKING_LEVEL
  const m = resolveModelCaps(registry, apiStyle, model)
  if (!m) {
    const levels = UNKNOWN_MODEL_LEVELS
    return levels.includes(requested) ? requested : (levels[levels.length - 1] ?? 'off')
  }
  return clampThinkingLevel(m, requested) as ModelThinkingLevel
}
