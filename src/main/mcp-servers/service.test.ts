import type { McpServerConfig } from '@shared/types/mcp'
import { describe, expect, it, vi } from 'vitest'

import { createService } from './service'
import type { McpServersState, Store } from './store'

// In-memory fake store: load() returns whatever was last saved (or the seed),
// letting us drive reload() deterministically without touching disk.
function fakeStore(seed: McpServerConfig[] = []): Store & { state: McpServersState } {
  const box = { state: { servers: seed } as McpServersState }
  return {
    state: box.state,
    load: vi.fn(async () => box.state),
    save: vi.fn(async (s: McpServersState) => {
      box.state = s
    }),
    watch: vi.fn(() => () => undefined),
    path: '/tmp/mcp-servers.json',
    // expose a setter for tests to simulate an external edit
    get _box() {
      return box
    },
  } as unknown as Store & { state: McpServersState }
}

const http = (name: string): Omit<McpServerConfig, 'id'> => ({
  name,
  transport: 'http',
  enabled: true,
  url: `http://127.0.0.1/${name}`,
})

describe('mcp service', () => {
  it('add assigns the name as id and persists', async () => {
    const store = fakeStore()
    const svc = await createService({ store })
    const r = await svc.add(http('workpanel'))
    expect(r).toEqual({ ok: true, id: 'workpanel' })
    expect(svc.list()[0].id).toBe('workpanel')
  })

  it('rejects a duplicate name', async () => {
    const svc = await createService({ store: fakeStore() })
    await svc.add(http('dup'))
    const r = await svc.add(http('dup'))
    expect(r).toMatchObject({ ok: false, code: 'duplicate_name' })
  })

  it('reload emits when the file content changed', async () => {
    const store = fakeStore()
    const svc = await createService({ store })
    const seen: McpServerConfig[][] = []
    svc.onChange((c) => seen.push(c))

    // Simulate an external edit landing on disk, then a watcher-driven reload.
    ;(store.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ servers: [{ ...http('added'), id: 'added' }] })
    await svc.reload()

    expect(seen.at(-1)?.map((s) => s.name)).toEqual(['added'])
  })

  it('reload is a no-op when content is unchanged (prevents self-write feedback loop)', async () => {
    const store = fakeStore([{ ...http('a'), id: 'a' }])
    const svc = await createService({ store })
    const seen: unknown[] = []
    svc.onChange(() => seen.push(1))

    await svc.reload() // load() returns the same servers → must not emit
    expect(seen).toHaveLength(0)
  })
})
