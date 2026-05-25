// src/main/providers/redact.ts
//
// Pure projection from on-disk providers state to renderer-visible view.
// Strips apiKey, replacing it with hasKey:boolean. NEVER call from the renderer.
import type { ProvidersStateOnDisk, ProvidersStateView } from '@shared/types/provider'

export function toView(state: ProvidersStateOnDisk): ProvidersStateView {
  return {
    active: state.active,
    providers: {
      anthropic: state.providers.anthropic
        ? { model: state.providers.anthropic.model, hasKey: true }
        : null,
      openai: state.providers.openai
        ? { model: state.providers.openai.model, hasKey: true }
        : null,
    },
  }
}
