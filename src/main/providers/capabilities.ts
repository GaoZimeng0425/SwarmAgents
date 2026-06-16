import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import { getModel } from '@earendil-works/pi-ai'
import type { ApiStyle, ProviderId } from '@shared/types/provider'

// pi-ai's getModel is strictly typed per known provider; loosen it like agent-runner does.
const getModelLoose = getModel as unknown as (provider: KnownProvider, modelId: string) => Model<Api> | undefined

/** Pure decision: unknown capability is permissive (don't block models we can't introspect). */
export function modelSupportsImagesFromInput(input: readonly string[] | undefined): boolean {
  return input ? input.includes('image') : true
}

/** Look up a model's image capability from the pi-ai registry. */
export function modelSupportsImages(providerId: ProviderId, apiStyle: ApiStyle | undefined, model: string): boolean {
  const lookup = (providerId === 'custom' ? (apiStyle ?? 'openai') : providerId) as KnownProvider
  return modelSupportsImagesFromInput(getModelLoose(lookup, model)?.input)
}
