//
// Service-side client for the symmetric mainRequest/mainResponse channel.
// mainRpc(method, args) posts a mainRequest on the parentPort and resolves
// when the matching mainResponse (by id) arrives. Mirrors the request side of
// the main-side ServiceClient.
import type { MainMethod } from '@swarm/protocol'

export type MainRpc = {
  mainRpc(method: MainMethod, args: unknown[]): Promise<unknown>
}

export type MainRpcDeps = {
  post(message: unknown): void
  subscribe(fn: (message: unknown) => void): () => void
}

export function createMainRpc(deps: MainRpcDeps): MainRpc {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()

  deps.subscribe((message) => {
    const msg = message as { kind?: string; id?: number; ok?: boolean; result?: unknown; error?: string }
    if (msg.kind !== 'mainResponse') return
    const p = msg.id != null ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error ?? 'main rpc failed'))
  })

  return {
    mainRpc(method, args) {
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        deps.post({ kind: 'mainRequest', id, method, args })
      })
    },
  }
}
