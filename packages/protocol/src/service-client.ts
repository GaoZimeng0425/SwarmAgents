import { createRpcPeer, type RpcTransport } from './rpc-peer'
import type { MainMethod, MainMethodSignatures, ServiceMethod, ServiceMethodSignatures } from './service-methods'
import { serviceMethodArgSchemas } from './service-methods'

// Kept as an alias so existing imports of ServiceTransport (desktop main,
// extension, RN) don't need to change.
export type ServiceTransport = RpcTransport

// The 45 RPC members are derived from the method table — adding a method to
// service-methods.ts adds it here automatically. Fire-and-forget methods now
// surface the wire-truth `{ ok: true }` result (previously typed void);
// callers that only await are unaffected.
export type ServiceClient = {
  [M in ServiceMethod]: (...args: ServiceMethodSignatures[M]['args']) => Promise<ServiceMethodSignatures[M]['result']>
} & {
  connect(): Promise<void>
  disconnect(): void
  // Registers a handler this side can serve for the other side's call() — e.g.
  // main registers 'weather.get_forecast' so the service process can call it.
  // Args are typed from the table; results stay unknown in this pass (callers
  // cast at the call site, as before).
  registerHandler<M extends MainMethod>(
    method: M,
    fn: (...args: MainMethodSignatures[M]['args']) => unknown | Promise<unknown>
  ): void
}

export function createServiceClient(cfg: {
  transport: ServiceTransport
  onEvent?: (event: string, data: unknown) => void
}): ServiceClient {
  const peer = createRpcPeer({
    transport: cfg.transport,
    onEvent: cfg.onEvent,
    // A request for a method nobody registered still gets an error response
    // (RpcPeer would do that on its own), but warn here first so the miss is
    // visible in this side's logs — a silent wrong-side dispatch is exactly
    // the bug class that made get_weather fall back to wttr.in. console, not
    // pino: @swarm/protocol stays logger-free for portability.
    defaultHandler: (method, _args, id) => {
      console.warn({ msg: 'no rpc handler', method, id })
      throw new Error(`no handler for ${method}`)
    },
  })

  const client: Record<string, unknown> = {
    connect: () => peer.connect(),
    disconnect: () => peer.disconnect(),
    registerHandler: (method: MainMethod, fn: (...args: unknown[]) => unknown) => peer.registerHandler(method, fn),
  }
  for (const method of Object.keys(serviceMethodArgSchemas) as ServiceMethod[]) {
    client[method] = (...args: unknown[]) => peer.call(method, args)
  }
  return client as unknown as ServiceClient
}
