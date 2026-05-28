// src/main/providers/redact.ts
//
// Pure projection from on-disk providers state to renderer-visible view.
// Strips apiKey, replacing it with hasKey:boolean. NEVER call from the renderer.
import type { ProvidersStateOnDisk, ProvidersStateView } from '@shared/types/provider'

function projectRow(row: ProvidersStateOnDisk['providers']['anthropic']): ProvidersStateView['providers']['anthropic'] {
  if (!row) return null
  return {
    model: row.model,
    hasKey: true,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.customModels && row.customModels.length > 0 ? { customModels: row.customModels } : {}),
    ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
  }
}

export function toView(state: ProvidersStateOnDisk): ProvidersStateView {
  return {
    active: state.active,
    providers: {
      anthropic: projectRow(state.providers.anthropic),
      openai: projectRow(state.providers.openai),
      custom: projectRow(state.providers.custom),
    },
  }
}
