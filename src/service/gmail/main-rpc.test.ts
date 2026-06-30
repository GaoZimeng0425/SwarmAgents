import { describe, expect, it } from 'vitest'
import { createMainRpc } from './main-rpc'

describe('service main-rpc client', () => {
  it('posts mainRequest and resolves on matched mainResponse', async () => {
    const posted: unknown[] = []
    const listeners = new Set<(m: unknown) => void>()
    const rpc = createMainRpc({
      post: (m: unknown) => posted.push(m),
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    })
    const p = rpc.mainRpc('gmail.search', ['inv', 5])
    expect(posted).toHaveLength(1)
    const req = posted[0] as { kind: string; id: number; method: string; args: unknown[] }
    expect(req.kind).toBe('mainRequest')
    expect(req.method).toBe('gmail.search')
    // Simulate main replying with the matching id.
    for (const l of listeners) l({ kind: 'mainResponse', id: req.id, ok: true, result: [{ id: 't1' }] })
    await expect(p).resolves.toEqual([{ id: 't1' }])
  })

  it('rejects on an error mainResponse', async () => {
    const posted: unknown[] = []
    const listeners = new Set<(m: unknown) => void>()
    const rpc = createMainRpc({
      post: (m: unknown) => posted.push(m),
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    })
    const p = rpc.mainRpc('gmail.get_thread', ['x'])
    const req = posted[0] as { id: number }
    for (const l of listeners) l({ kind: 'mainResponse', id: req.id, ok: false, error: 'nope' })
    await expect(p).rejects.toThrow('nope')
  })
})
