import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createNodeForkSpawner } from './node-fork-spawner'

describe('NodeForkSpawner', () => {
  it('spawns a process and round-trips a message', async () => {
    const dir = mkdtempSync(`${tmpdir()}/swarm-test-`)
    const fixture = resolve(dir, 'echo-worker.cjs')
    writeFileSync(
      fixture,
      `process.on('message', (m) => { if (m === 'bye') process.exit(0); process.send({ echoed: m }); });`,
    )

    const spawner = createNodeForkSpawner()
    const handle = spawner.spawn({ entry: fixture, workerId: 'w-test' })

    const received: unknown[] = []
    handle.onMessage((m) => received.push(m))

    handle.send('hello')
    await new Promise((r) => setTimeout(r, 100))

    expect(received).toEqual([{ echoed: 'hello' }])

    handle.send('bye')
    const exitCode = await handle.exited
    expect(exitCode).toBe(0)
  })
})
