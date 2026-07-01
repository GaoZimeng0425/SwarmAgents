import type { ModelThinkingLevel, ProviderInjection } from './provider'

/**
 * A named slot in a multi-model scheduling policy. The orchestrator maps a role
 * to a configured provider (by key) rather than hard-coding model ids, so the
 * same agent code runs on a cheap model in one deployment and a top model in
 * another just by re-binding the role.
 *
 * - `planner`        — task decomposition / hard reasoning (top model + deep thinking)
 * - `worker_strong`  — reasoning-heavy execution subtasks
 * - `worker_fast`    — mechanical / single-step execution subtasks (cheap model)
 * - `vision`         — image understanding / visual Q&A
 * - `ocr`            — text extraction from images
 */
export type ModelRole = 'planner' | 'worker_strong' | 'worker_fast' | 'vision' | 'ocr'

/**
 * Binds a role to a concrete provider. `providerKey` references a configured
 * provider; `model`/`thinkingLevel` optionally override that provider's
 * defaults (mirrors how an AgentDefinition overrides `provider.model`).
 * `fallbacks` is an ordered list tried when the primary's request fails — each
 * is itself a binding, so a fallback can live on a different provider entirely.
 */
export type RoleBinding = {
  providerKey: string
  model?: string
  thinkingLevel?: ModelThinkingLevel
  fallbacks?: RoleBinding[]
}

/** A deployment's role→provider policy. Roles left unset fall back to the session provider. */
export type RoleMap = Partial<Record<ModelRole, RoleBinding>>

/**
 * Resolve a role binding into an ordered chain of provider injections:
 * `[primary, ...fallbacks]`. Each binding's `model`/`thinkingLevel` override its
 * base provider's defaults. Bindings whose `providerKey` cannot be resolved are
 * skipped (a misconfigured fallback must not abort the chain).
 *
 * Pure: the caller supplies `getProvider`; no I/O here.
 */
export function resolveRoleChain(
  binding: RoleBinding,
  getProvider: (key: string) => ProviderInjection | undefined
): ProviderInjection[] {
  const bindings = [binding, ...(binding.fallbacks ?? [])]
  const chain: ProviderInjection[] = []
  for (const b of bindings) {
    const base = getProvider(b.providerKey)
    if (!base) continue
    chain.push({
      ...base,
      ...(b.model ? { model: b.model } : {}),
      ...(b.thinkingLevel ? { thinkingLevel: b.thinkingLevel } : {}),
    })
  }
  return chain
}
