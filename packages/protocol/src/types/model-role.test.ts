import { describe, expect, it } from 'vitest'

import { resolveRoleChain } from './model-role'
import type { ProviderInjection } from './provider'

const provider = (id: string, model: string): ProviderInjection => ({
  id,
  apiStyle: 'anthropic',
  model,
  apiKey: `key-${id}`,
})

const directory: Record<string, ProviderInjection> = {
  anthropic: provider('anthropic', 'claude-opus-4-8'),
  deepseek: provider('deepseek', 'deepseek-chat'),
}
const getProvider = (key: string): ProviderInjection | undefined => directory[key]

describe('resolveRoleChain', () => {
  it('applies model and thinkingLevel overrides onto the base provider', () => {
    const chain = resolveRoleChain(
      { providerKey: 'anthropic', model: 'claude-opus-4-8', thinkingLevel: 'xhigh' },
      getProvider
    )

    expect(chain).toHaveLength(1)
    expect(chain[0]).toMatchObject({
      id: 'anthropic',
      apiKey: 'key-anthropic',
      model: 'claude-opus-4-8',
      thinkingLevel: 'xhigh',
    })
  })

  it('preserves the base provider verbatim when there are no overrides', () => {
    const chain = resolveRoleChain({ providerKey: 'deepseek' }, getProvider)

    expect(chain).toEqual([directory.deepseek])
  })

  it('produces an ordered chain of [primary, ...fallbacks], each on its own provider', () => {
    const chain = resolveRoleChain(
      {
        providerKey: 'anthropic',
        model: 'claude-opus-4-8',
        fallbacks: [{ providerKey: 'deepseek', model: 'deepseek-reasoner' }],
      },
      getProvider
    )

    expect(chain.map((p) => [p.id, p.model])).toEqual([
      ['anthropic', 'claude-opus-4-8'],
      ['deepseek', 'deepseek-reasoner'],
    ])
  })

  it('skips bindings whose providerKey cannot be resolved', () => {
    const chain = resolveRoleChain(
      {
        providerKey: 'anthropic',
        fallbacks: [{ providerKey: 'ghost' }, { providerKey: 'deepseek' }],
      },
      getProvider
    )

    expect(chain.map((p) => p.id)).toEqual(['anthropic', 'deepseek'])
  })

  it('returns an empty chain when even the primary provider is unknown', () => {
    expect(resolveRoleChain({ providerKey: 'ghost' }, getProvider)).toEqual([])
  })
})
