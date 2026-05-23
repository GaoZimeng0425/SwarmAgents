import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createNodeForkSpawner } from './node-fork-spawner'

describe('NodeForkSpawner', () => {
  it('spawns a process and round-trips a message', async () => {
    const dir = mkdtempSync(`${tmpdir()}/swarm-test-`)
    const fixture = resolve(dir, 'echo-worker.cjs')
    writeFileSync(
      fixture,
      `process.on('message', (m) => { if (m === 'bye') process.exit(0); process.send({ echoed: m }); });`
    )

    const spawner = createNodeForkSpawner()
    const handle = spawner.spawn({ entry: fixture, workerId: 'w-test' })

    // Wait for the echo response by promise rather than a fixed sleep —
    // the test runs in a parallel forks pool and timing margins shrink
    // when several spawner tests are competing for the same CPU.
    const firstMessage = new Promise<unknown>((resolveMsg) => {
      handle.onMessage((m) => resolveMsg(m))
    })

    handle.send('hello')
    const got = await firstMessage
    expect(got).toEqual({ echoed: 'hello' })

    handle.send('bye')
    const exitCode = await handle.exited
    expect(exitCode).toBe(0)
  })
})
