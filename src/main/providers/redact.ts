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
