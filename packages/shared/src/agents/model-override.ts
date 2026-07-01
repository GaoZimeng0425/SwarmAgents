import type { AgentDefinition, ProviderInjection } from '@swarm/protocol'

/**
 * Apply an agent type's model-tier overrides onto a provider injection. An agent
 * definition may pin a cheaper/stronger `model` and a `thinkingLevel` (the tier
 * control), so a planner runs deep and a fast worker runs cheap on the same
 * provider. Other injection fields — crucially the resolved `fallbackProviders`
 * chain and the apiKey — are preserved. Returns the injection unchanged when the
 * agent pins neither, so the common case allocates nothing.
 */
export function applyAgentModel(
  provider: ProviderInjection,
  def: Pick<AgentDefinition, 'model' | 'thinkingLevel'>
): ProviderInjection {
  if (!def.model && !def.thinkingLevel) return provider
  return {
    ...provider,
    ...(def.model ? { model: def.model } : {}),
    ...(def.thinkingLevel ? { thinkingLevel: def.thinkingLevel } : {}),
  }
}
