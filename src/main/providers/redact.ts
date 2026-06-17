// src/main/providers/redact.ts
//
// Pure projection from on-disk providers state (v2) to the renderer-visible
// view. Strips apiKey, replacing it with hasKey:boolean. NEVER call from the
// renderer.
import type {
  CustomProviderOnDisk,
  CustomProviderView,
  ProviderRowOnDisk,
  ProviderRowView,
  ProvidersStateOnDisk,
  ProvidersStateView,
} from '@shared/types/provider'

import { effectiveThinkingLevel, modelSupportsImages, modelThinkingLevels } from './capabilities'

type LookupKind = 'anthropic' | 'openai' | 'custom'

function projectRow(kind: LookupKind, row: ProviderRowOnDisk | null): ProviderRowView | null {
  if (!row) return null
  return {
    model: row.model,
    hasKey: true,
    supportsImages: modelSupportsImages(kind, row.apiStyle, row.model),
    thinkingLevels: modelThinkingLevels(kind, row.apiStyle, row.model),
    thinkingLevel: effectiveThinkingLevel(kind, row.apiStyle, row.model, row.thinkingLevel),
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.customModels && row.customModels.length > 0 ? { customModels: row.customModels } : {}),
    ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
  }
}

function projectCustom(c: CustomProviderOnDisk): CustomProviderView {
  // A custom row always has hasKey:true and apiStyle set, so projectRow never
  // returns null here.
  const base = projectRow('custom', c) as ProviderRowView
  return { ...base, id: c.id, name: c.name }
}

export function toView(state: ProvidersStateOnDisk): ProvidersStateView {
  return {
    active: state.active,
    builtins: {
      anthropic: projectRow('anthropic', state.builtins.anthropic),
      openai: projectRow('openai', state.builtins.openai),
    },
    custom: state.custom.map(projectCustom),
  }
}
