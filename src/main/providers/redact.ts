// src/main/providers/redact.ts
//
// Pure projection from on-disk providers state (v3) to the renderer-visible
// view. Strips apiKey, replacing it with hasKey:boolean. NEVER call from the
// renderer.
import type { Provider, ProvidersStateOnDisk, ProvidersStateView, ProviderView } from '@shared/types/provider'

import { effectiveThinkingLevel, modelSupportsImages, modelThinkingLevels } from './capabilities'

function projectProvider(p: Provider): ProviderView {
  return {
    id: p.id,
    name: p.name,
    ...(p.registry ? { registry: p.registry } : {}),
    apiStyle: p.apiStyle,
    hasKey: true,
    supportsImages: modelSupportsImages(p.registry, p.apiStyle, p.model),
    models: p.models,
    model: p.model,
    thinkingLevels: modelThinkingLevels(p.registry, p.apiStyle, p.model),
    thinkingLevel: effectiveThinkingLevel(p.registry, p.apiStyle, p.model, p.thinkingLevel),
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
  }
}

export function toView(state: ProvidersStateOnDisk): ProvidersStateView {
  return {
    active: state.active,
    providers: state.providers.map(projectProvider),
  }
}
