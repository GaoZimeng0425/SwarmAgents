import type { OpenAICompletionsCompat, ThinkingLevelMap } from '@earendil-works/pi-ai'

/**
 * Per-model-family reasoning parameter specs — the provider adaptation layer.
 *
 * pi-ai already serializes the app's unified thinking level into each provider's
 * own wire format (GLM/Z.ai → `thinking: { type }` + `reasoning_effort`,
 * DeepSeek → `thinking: { type }` + `reasoning_effort`, …). It does so by reading
 * the resolved model's metadata: `compat.thinkingFormat`,
 * `compat.supportsReasoningEffort`, and `thinkingLevelMap`.
 *
 * The catch: this project only knows the `anthropic`/`openai` registries, so
 * models like GLM, DeepSeek, or MiMo are configured as plain OpenAI-style custom
 * endpoints. Those are resolved from a fallback template whose reasoning metadata
 * is absent or wrong, so the correct thinking params never reach the wire.
 *
 * This table re-supplies that metadata by matching the model id. The graft itself
 * lives in `agent-runner`'s `cloneTemplate`, which spreads `reasoningOverridesFor`.
 */

// The subset of pi-ai's OpenAICompletionsCompat that selects how the thinking
// parameter is serialized. Every other compat field stays auto-detected from the
// endpoint URL (pi-ai's `getCompat` merges per field: `model.compat.x ?? detected.x`).
type ReasoningCompat = Pick<OpenAICompletionsCompat, 'thinkingFormat' | 'supportsReasoningEffort'>

export type ModelReasoningSpec = {
  /** Family this spec applies to, matched against the model id (case-insensitive). */
  match: RegExp
  /** Whether the model reasons at all — enables reasoning streaming in pi-ai. */
  reasoning: boolean
  /** How the thinking level is serialized on the wire. Omit for the "openai" default. */
  compat?: ReasoningCompat
  /** Maps the app's abstract depth to the provider's wire value (`null` disables thinking). */
  thinkingLevelMap?: ThinkingLevelMap
}

// First match wins — keep specific patterns above general ones.
export const MODEL_REASONING_SPECS: readonly ModelReasoningSpec[] = [
  // GLM / Z.ai — `thinking: { type: enabled|disabled }` plus `reasoning_effort`
  // ("high" for any on-depth, "max" for xhigh). Mirrors pi-ai's glm-5.2 entry.
  {
    match: /^glm-/i,
    reasoning: true,
    compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
    thinkingLevelMap: { minimal: null, low: 'high', medium: 'high', high: 'high', xhigh: 'max' },
  },
  // DeepSeek — `thinking: { type: enabled|disabled }` plus `reasoning_effort`
  // when reasoning is on. Only high/xhigh enable it; lower depths disable thinking.
  {
    match: /^deepseek/i,
    reasoning: true,
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
  },
  // MiMo (Xiaomi) — reasons natively; its API has no `reasoning_effort` knob, so
  // keep the default "openai" format and never send one.
  {
    match: /^(mimo|xiaomimimo\/)/i,
    reasoning: true,
    compat: { supportsReasoningEffort: false },
  },
]

/** First reasoning spec whose pattern matches the model id, else undefined. */
export function reasoningSpecFor(modelId: string): ModelReasoningSpec | undefined {
  return MODEL_REASONING_SPECS.find((spec) => spec.match.test(modelId))
}

// The model fields a matched spec contributes, ready to spread onto a resolved
// model template.
export type ReasoningOverrides = {
  reasoning: boolean
  compat?: ReasoningCompat
  thinkingLevelMap?: ThinkingLevelMap
}

/** Reasoning model fields for `modelId`, or undefined when no family matches. */
export function reasoningOverridesFor(modelId: string): ReasoningOverrides | undefined {
  const spec = reasoningSpecFor(modelId)
  if (!spec) return undefined
  return {
    reasoning: spec.reasoning,
    ...(spec.compat ? { compat: spec.compat } : {}),
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
  }
}
