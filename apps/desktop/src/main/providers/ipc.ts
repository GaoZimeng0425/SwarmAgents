// src/main/providers/ipc.ts
//
// Wires the providers subsystem to Electron IPC. Exposes get / setKey / clearKey
// / setActive / setModel / apiStyle / thinking / contextWindow / baseUrl /
// custom-model handlers, the custom-provider lifecycle (add/remove/rename), and
// a test handler. Broadcasts state changes to all renderer windows.
import { createLogger } from '@shared/logger'
import { type ApiStyle, type ModelMeta, ModelThinkingLevel } from '@swarm/protocol'

import { paths } from '../constants'
import { createIpcRegistrar, sendToAllWindows } from '../ipc/wire'
import { fetchCatalog, lookupModel } from './openrouter'
import type { AddCustomInput, Service } from './service'
import { testConnection } from './test-connection'

const log = createLogger({ process: 'main' }).child({ component: 'providers-ipc' })

// Any provider id (builtin 'anthropic'/'openai' or a custom uuid). The service
// rejects unknown ids; here we only guard the wire type.
function asId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null
}

const badId = { ok: false as const, code: 'invalid' as const, message: 'invalid provider id' }

export function wireProvidersIpc(args: { service: Service }): { dispose: () => void } {
  const { service } = args
  const ipc = createIpcRegistrar()

  const unsubscribe = service.onStateChanged((view) => {
    sendToAllWindows('providers:stateChanged', view)
  })

  const catalogPath = paths.openrouterCatalog()

  // Best-effort: pull pricing/context for the given custom-provider models from
  // the locally-cached OpenRouter catalog and merge into modelMeta — so adding a
  // model auto-fills its price without a manual "fetch" click. Uses the cached/
  // disk copy (no forced network), and never throws: an add must still succeed
  // when offline or unmatched. The merge persists, which broadcasts the updated
  // state to renderers, so pricing pops in shortly after the add.
  const autoMatchPricing = async (id: string, requested: string[]): Promise<void> => {
    try {
      const provider = service.getState().providers.find((x) => x.id === id)
      if (!provider || provider.registry) return // custom providers only
      // Resolve each request to the provider's canonical stored id (case-/space-
      // insensitive), since mergeModelMeta only accepts ids already in the list.
      // Skip models that already carry pricing so re-selecting one (setModel
      // fires on every selection) doesn't churn a needless persist+broadcast.
      const targets = requested
        .map((m) => provider.models.find((pm) => pm.toLowerCase() === m.trim().toLowerCase()))
        .filter((m): m is string => !!m && !provider.modelMeta?.[m]?.pricing)
      if (targets.length === 0) return
      const catalog = await fetchCatalog({ catalogPath })
      const map: Record<string, ModelMeta> = {}
      for (const m of targets) {
        const meta = lookupModel(catalog, m)
        if (meta) map[m] = meta
      }
      if (Object.keys(map).length === 0) {
        log.warn({ msg: 'auto-match pricing: no models matched', id, targets })
        return
      }
      await service.mergeModelMeta(id, map)
      log.info({ msg: 'auto-match pricing applied', id, matched: Object.keys(map).length, total: targets.length })
    } catch (e) {
      log.warn({ msg: 'auto-match pricing failed', id, err: e instanceof Error ? e.message : String(e) })
    }
  }

  ipc.handle('providers:get', () => service.getView())

  ipc.handle('providers:setKey', (_e: Electron.IpcMainInvokeEvent, p: unknown, key: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof key !== 'string') return { ok: false, code: 'invalid', message: 'key must be a string' }
    return service.setKey(id, key)
  })

  ipc.handle('providers:clearKey', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    return id ? service.clearKey(id) : badId
  })

  ipc.handle('providers:setActive', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    if (p === null) return service.setActive(null)
    const id = asId(p)
    return id ? service.setActive(id) : badId
  })

  ipc.handle('providers:setModel', async (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    const r = await service.setModel(id, model)
    // setModel adds the model to the list when new — auto-fill its pricing too.
    if (r.ok) void autoMatchPricing(id, [model])
    return r
  })

  ipc.handle('providers:addCustomModel', async (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    const r = await service.addCustomModel(id, model)
    if (r.ok) void autoMatchPricing(id, [model])
    return r
  })

  ipc.handle('providers:removeCustomModel', (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
    return service.removeCustomModel(id, model)
  })

  ipc.handle('providers:setApiStyle', (_e: Electron.IpcMainInvokeEvent, p: unknown, style: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (style !== 'anthropic' && style !== 'openai')
      return { ok: false, code: 'invalid', message: 'apiStyle must be "anthropic" or "openai"' }
    return service.setApiStyle(id, style)
  })

  ipc.handle('providers:setThinkingLevel', (_e: Electron.IpcMainInvokeEvent, p: unknown, level: unknown) => {
    const id = asId(p)
    if (!id) return badId
    const lvl = ModelThinkingLevel.safeParse(level)
    if (!lvl.success) return { ok: false, code: 'invalid', message: 'unknown thinking level' }
    return service.setThinkingLevel(id, lvl.data)
  })

  ipc.handle('providers:setFallbackProviderIds', (_e: Electron.IpcMainInvokeEvent, p: unknown, ids: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string'))
      return { ok: false, code: 'invalid', message: 'fallbackProviderIds must be an array of strings' }
    return service.setFallbackProviderIds(id, ids as string[])
  })

  ipc.handle(
    'providers:setModelContextWindow',
    (_e: Electron.IpcMainInvokeEvent, p: unknown, model: unknown, contextWindow: unknown) => {
      const id = asId(p)
      if (!id) return badId
      if (typeof model !== 'string') return { ok: false, code: 'invalid', message: 'model must be a string' }
      if (contextWindow !== null && typeof contextWindow !== 'number')
        return { ok: false, code: 'invalid', message: 'contextWindow must be a number or null' }
      return service.setModelContextWindow(id, model, contextWindow)
    }
  )

  ipc.handle('providers:fetchModelInfo', async (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    if (!id) return { ok: false as const, code: 'invalid' as const, message: 'invalid provider id' }
    const provider = service.getState().providers.find((x) => x.id === id)
    if (!provider) return { ok: false as const, code: 'invalid' as const, message: `unknown provider "${id}"` }
    if (provider.registry)
      return {
        ok: false as const,
        code: 'invalid' as const,
        message: 'OpenRouter fetch applies to custom providers only',
      }
    const total = provider.models.length
    log.info({ msg: 'fetch model info', id, total })
    let catalog: Awaited<ReturnType<typeof fetchCatalog>>
    try {
      // Manual button = explicit refresh: force a network re-download (and
      // re-persist to disk), rather than serving the cached copy.
      catalog = await fetchCatalog({ force: true, catalogPath })
    } catch (e) {
      log.error({ msg: 'fetch model info network failure', id, err: e instanceof Error ? e.message : String(e) })
      return { ok: false as const, code: 'network' as const, message: e instanceof Error ? e.message : String(e) }
    }
    const map: Record<string, ModelMeta> = {}
    const unmatched: string[] = []
    for (const m of provider.models) {
      const meta = lookupModel(catalog, m)
      if (meta) map[m] = meta
      else unmatched.push(m)
    }
    const r = await service.mergeModelMeta(id, map)
    if (!r.ok) return { ok: false as const, code: 'invalid' as const, message: r.message }
    if (unmatched.length) log.warn({ msg: 'models unmatched on openrouter', id, unmatched })
    const matched = total - unmatched.length
    log.info({ msg: 'fetch model info done', id, matched, total })
    return { ok: true as const, matched, total, unmatched }
  })

  ipc.handle('providers:setBaseUrl', (_e: Electron.IpcMainInvokeEvent, p: unknown, baseUrl: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (baseUrl !== null && typeof baseUrl !== 'string')
      return { ok: false, code: 'invalid', message: 'baseUrl must be a string or null' }
    return service.setBaseUrl(id, baseUrl)
  })

  ipc.handle('providers:addCustomProvider', async (_e: Electron.IpcMainInvokeEvent, input: unknown) => {
    if (!input || typeof input !== 'object') return { ok: false, code: 'invalid', message: 'input must be an object' }
    const i = input as Partial<AddCustomInput>
    if (typeof i.name !== 'string' || typeof i.apiKey !== 'string')
      return { ok: false, code: 'invalid', message: 'name and apiKey are required' }
    if (i.apiStyle !== 'anthropic' && i.apiStyle !== 'openai')
      return { ok: false, code: 'invalid', message: 'apiStyle must be "anthropic" or "openai"' }
    if (!Array.isArray(i.models) || i.models.some((m) => typeof m !== 'string'))
      return { ok: false, code: 'invalid', message: 'models must be an array of strings' }
    const r = await service.addCustomProvider({
      name: i.name,
      apiKey: i.apiKey,
      apiStyle: i.apiStyle as ApiStyle,
      baseUrl: typeof i.baseUrl === 'string' ? i.baseUrl : null,
      models: i.models as string[],
      ...(i.thinkingLevel ? { thinkingLevel: i.thinkingLevel } : {}),
    })
    if (r.ok) void autoMatchPricing(r.id, i.models as string[])
    return r
  })

  ipc.handle('providers:removeCustomProvider', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    return id ? service.removeCustomProvider(id) : badId
  })

  ipc.handle('providers:renameCustomProvider', (_e: Electron.IpcMainInvokeEvent, p: unknown, name: unknown) => {
    const id = asId(p)
    if (!id) return badId
    if (typeof name !== 'string') return { ok: false, code: 'invalid', message: 'name must be a string' }
    return service.renameCustomProvider(id, name)
  })

  ipc.handle('providers:test', (_e: Electron.IpcMainInvokeEvent, p: unknown) => {
    const id = asId(p)
    if (!id) return { ok: false, code: 'unknown', message: 'invalid provider id' }
    const provider = service.getState().providers.find((x) => x.id === id)
    if (!provider) return { ok: false, code: 'no_key', message: 'no key configured' }
    return testConnection({
      id: provider.id,
      ...(provider.registry ? { registry: provider.registry } : {}),
      apiStyle: provider.apiStyle,
      model: provider.model,
      apiKey: provider.apiKey,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    })
  })

  log.info({ msg: 'providers IPC wired' })

  return {
    dispose(): void {
      unsubscribe()
      ipc.dispose()
    },
  }
}
