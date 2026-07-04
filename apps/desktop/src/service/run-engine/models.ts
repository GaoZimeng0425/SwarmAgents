import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel as getModel, getBuiltinModels as getModels } from '@earendil-works/pi-ai/providers/all'
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  type ApiStyle,
  DEFAULT_CONTEXT_WINDOW,
  type ModelPricing,
  OPENAI_MODEL_SUGGESTIONS,
  type ProviderInjection,
} from '@swarm/protocol'
import { reasoningOverridesFor } from '@swarm/shared'

// `getModel`'s generics demand a literal model-id key per provider. Our
// `ProviderInjection.model` is a runtime-validated string (Zod-checked at the
// IPC boundary), so we erase the literal constraint via a looser local
// alias. This avoids `as any` and keeps callers strict.
const getModelLoose = getModel as unknown as (provider: KnownProvider, modelId: string) => Model<Api> | undefined

const FALLBACK_MODEL_ID: Record<ApiStyle, string> = {
  anthropic: ANTHROPIC_MODEL_SUGGESTIONS[0],
  openai: OPENAI_MODEL_SUGGESTIONS[0],
}

const API_FOR_STYLE: Record<ApiStyle, Api> = {
  openai: 'openai-completions',
  anthropic: 'anthropic-messages',
}

// Maps OpenRouter-derived pricing (USD/1M tokens) to pi-ai's Model.cost shape
// (also USD/1M). Absent cache prices default to 0. Exported for unit testing.
export function pricingToCost(pricing: ModelPricing): Model<Api>['cost'] {
  return {
    input: pricing.inputPerM,
    output: pricing.outputPerM,
    cacheRead: pricing.cacheReadPerM ?? 0,
    cacheWrite: pricing.cacheWritePerM ?? 0,
  }
}

function cloneTemplate(
  template: Model<Api>,
  p: ProviderInjection,
  style: ApiStyle,
  contextWindow?: number
): Model<Api> {
  const { compat: _drop, ...rest } = template
  // Re-attach reasoning wire metadata for known custom families (GLM/DeepSeek/
  // MiMo). Without this graft a custom endpoint inherits the fallback template's
  // reasoning fields, so pi-ai can't emit the provider's own thinking params.
  const reasoning = reasoningOverridesFor(p.model)
  return {
    ...rest,
    id: p.model,
    baseUrl: p.baseUrl ?? template.baseUrl,
    api: API_FOR_STYLE[style],
    ...(contextWindow != null ? { contextWindow } : {}),
    // Custom-model pricing (from OpenRouter) overrides the fallback template's
    // cost so pi-ai's calculateCost() produces real per-turn cost for usdCents.
    ...(p.pricing ? { cost: pricingToCost(p.pricing) } : {}),
    ...(reasoning ?? {}),
  }
}

export function resolveModel(p: ProviderInjection): Model<Api> {
  // `registry` is the single discriminator: absent ⇒ a custom endpoint pi-ai
  // doesn't know, looked up by its wire style (apiStyle); present ⇒ a valid
  // pi-ai provider key with a real model catalog. Nothing branches on the id.
  if (!p.registry) {
    const style = p.apiStyle
    const matched = getModelLoose(style, p.model)
    const template =
      matched ?? getModelLoose(style, FALLBACK_MODEL_ID[style]) ?? (getModels(style)[0] as Model<Api> | undefined)
    if (!template) throw new Error(`pi-ai has no registered models for style "${style}"`)
    // A custom endpoint's model is often unknown to pi-ai, so its window would
    // otherwise inherit the fallback template's (gpt-4o = 128k) — wrong for the
    // real model. Honor the user's override, else the matched model's real
    // window, else a sane 200k default.
    const contextWindow = p.contextWindow ?? matched?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    return cloneTemplate(template, p, style, contextWindow)
  }

  const exact = getModelLoose(p.registry, p.model)
  if (exact && !p.baseUrl) return exact

  const template =
    exact ??
    getModelLoose(p.registry, FALLBACK_MODEL_ID[p.registry]) ??
    (getModels(p.registry)[0] as Model<Api> | undefined)
  if (!template) throw new Error(`pi-ai has no registered models for provider "${p.registry}"`)

  return cloneTemplate(template, p, p.registry)
}

// Whether an injection's resolved model accepts image input — used to pick a
// vision model from the provider chain for the analyze_image tool. Unresolvable
// models are treated as not image-capable.
export function injectionSupportsImages(p: ProviderInjection): boolean {
  try {
    return resolveModel(p).input?.includes('image') ?? false
  } catch {
    return false
  }
}

// Prepend task-scoped context to the agent's base system prompt so the model
// honors the composer's choices: the working directory (relative paths/commands
// land there) and, in plan mode, the read-only "produce a plan first" constraint.
export function composeSystemPrompt(base: string, ctx: { cwd?: string; executionMode?: 'goal' | 'plan' }): string {
  const prefix: string[] = []
  if (ctx.cwd) {
    prefix.push(
      `Working directory: ${ctx.cwd}. Treat it as the base for relative paths and run commands there unless told otherwise.`
    )
  }
  if (ctx.executionMode === 'plan') {
    prefix.push(
      'You are in PLAN mode. Investigate using read-only tools and produce a step-by-step plan with update_plan. Do NOT modify files or run mutating commands — you have no write tools.'
    )
  }
  return prefix.length ? `${prefix.join('\n\n')}\n\n${base}` : base
}
