import { describe, expectTypeOf, it } from 'vitest'

import type { RendererIpcEvents, RendererIpcSignatures } from './renderer-ipc'
import type { ServiceMethodSignatures } from './service-methods'
import type { UIEvent } from './types/ui'

describe('RendererIpcSignatures', () => {
  it('passthrough entries mirror the service table exactly', () => {
    expectTypeOf<RendererIpcSignatures['swarm:listSessions']>().toEqualTypeOf<ServiceMethodSignatures['listSessions']>()
    expectTypeOf<RendererIpcSignatures['skills:list']>().toEqualTypeOf<ServiceMethodSignatures['listSkills']>()
    expectTypeOf<RendererIpcSignatures['swarm:submitPrompt']>().toEqualTypeOf<ServiceMethodSignatures['submitPrompt']>()
  })

  it('main-transformed entries diverge deliberately from the service table', () => {
    // createSession: renderer sends no args; main injects the provider.
    expectTypeOf<RendererIpcSignatures['swarm:createSession']['args']>().toEqualTypeOf<[]>()
    // cancelRun: main swallows errors and resolves void (not { ok: true }).
    expectTypeOf<RendererIpcSignatures['swarm:cancelRun']['result']>().toEqualTypeOf<void>()
  })

  it('event payloads are typed', () => {
    expectTypeOf<RendererIpcEvents['swarm:event']>().toEqualTypeOf<UIEvent>()
    expectTypeOf<RendererIpcEvents['system:accentChange']>().toEqualTypeOf<{ hex: string }>()
  })

  it('plan-2 domain entries model the wire, not the bridge facade', () => {
    // bilibili:save takes the full video + summary (fav deletion needs the fav* ids)
    expectTypeOf<RendererIpcSignatures['bilibili:save']['args']>().toEqualTypeOf<
      [import('./types/bilibili').BiliVideo, import('./types/bilibili').BiliSummary]
    >()
    // providers mutations resolve ProvidersSetResult on the wire
    expectTypeOf<RendererIpcSignatures['providers:setKey']['result']>().toEqualTypeOf<
      import('./types/ui').ProvidersSetResult
    >()
    // budgets:set resolves the SetResult union
    expectTypeOf<RendererIpcSignatures['budgets:set']['result']>().toEqualTypeOf<
      import('./types/ui').BudgetsSetResult
    >()
  })
})
