// src/main/providers/redact.ts
//
// Pure projection from on-disk providers state to renderer-visible view.
// Strips apiKey, replacing it with hasKey:boolean. NEVER call from the renderer.
import type { ProviderId, ProvidersStateOnDisk, ProvidersStateView } from '@shared/types/provider'

import { effectiveThinkingLevel, modelSupportsImages, modelThinkingLevels } from './capabilities'

function projectRow(
  id: ProviderId,
  row: ProvidersStateOnDisk['providers']['anthropic']
): ProvidersStateView['providers']['anthropic'] {
  if (!row) return null
  return {
    model: row.model,
    hasKey: true,
    supportsImages: modelSupportsImages(id, row.apiStyle, row.model),
    thinkingLevels: modelThinkingLevels(id, row.apiStyle, row.model),
    thinkingLevel: effectiveThinkingLevel(id, row.apiStyle, row.model, row.thinkingLevel),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.customModels && row.customModels.length > 0 ? { customModels: row.customModels } : {}),
    ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
  }
}

export function toView(state: ProvidersStateOnDisk): ProvidersStateView {
  return {
    active: state.active,
    providers: {
      anthropic: projectRow('anthropic', state.providers.anthropic),
      openai: projectRow('openai', state.providers.openai),
      custom: projectRow('custom', state.providers.custom),
    },
  }
}
