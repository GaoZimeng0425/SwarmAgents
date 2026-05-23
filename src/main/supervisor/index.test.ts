import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createNodeForkSpawner } from './node-fork-spawner'
import { createSupervisor } from './index'
import type { Task } from '@shared/types/task'

function buildEchoFixture(): string {
  const dir = mkdtempSync(`${tmpdir()}/swarm-supervisor-`)
  const fixture = resolve(dir, 'echo-worker.cjs')
  writeFileSync(
    fixture,
    `
process.on('message', (m) => {
  if (m && m.type === 'task.assign') {
    process.send({ type: 'task.complete', taskId: m.task.id, result: { summary: 'echo:' + m.task.goal, artifacts: [] } });
  }
  if (m && m.type === 'shutdown') process.exit(0);
});
setInterval(() => process.send({ type: 'heartbeat', ts: Date.now() }), 1000).unref();
    `,
  )
  return fixture
}

const mkTask = (id: string, goal: string): Task => ({
  id, parentId: null, goal,
  status: 'dispatched',
  assignedWorkerId: null,
  toolAllowlist: [],
  budget: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  used: { tokens: 0, calls: 0, wallMs: 0, usdCents: 0 },
  history: [], result: null,
  createdAt: Date.now(), startedAt: null, endedAt: null,
})

describe('WorkerSupervisor', () => {
  it('dispatches a task to an idle worker and receives completion', async () => {
    const entry = buildEchoFixture()
    const sup = createSupervisor({
      spawner: createNodeForkSpawner(),
      workerEntry: entry,
      poolSize: 1,
    })

    const completed: string[] = []
    sup.on('task.complete', (taskId) => completed.push(taskId))

    await sup.start()
    const t = mkTask('01HX0000000000000000000001', 'hello')
    sup.dispatch(t)

    await new Promise((r) => setTimeout(r, 300))
    expect(completed).toContain('01HX0000000000000000000001')

    await sup.shutdown()
  })

  it('queues tasks when all workers are busy and drains them', async () => {
    const entry = buildEchoFixture()
    const sup = createSupervisor({
      spawner: createNodeForkSpawner(),
      workerEntry: entry,
      poolSize: 1,
    })
    const completed: string[] = []
    sup.on('task.complete', (taskId) => completed.push(taskId))

    await sup.start()
    sup.dispatch(mkTask('01HX0000000000000000000001', 'a'))
    sup.dispatch(mkTask('01HX0000000000000000000002', 'b'))
    sup.dispatch(mkTask('01HX0000000000000000000003', 'c'))

    await new Promise((r) => setTimeout(r, 800))
    expect(completed.sort()).toEqual([
      '01HX0000000000000000000001',
      '01HX0000000000000000000002',
      '01HX0000000000000000000003',
    ])

    await sup.shutdown()
  })

  it('replaces a worker whose heartbeat goes silent', async () => {
    const dir = mkdtempSync(`${tmpdir()}/swarm-silent-`)
    const fixture = resolve(dir, 'silent-then-echo.cjs')
    writeFileSync(
      fixture,
      `
process.on('message', (m) => {
  if (m && m.type === 'task.assign') {
    process.send({ type: 'task.complete', taskId: m.task.id, result: { summary: 'ok', artifacts: [] } });
  }
  if (m && m.type === 'shutdown') process.exit(0);
});
// No heartbeat. Spawn-time only. Supervisor must detect via watchdog.
      `,
    )

    const sup = createSupervisor({
      spawner: createNodeForkSpawner(),
      workerEntry: fixture,
      poolSize: 1,
      heartbeatTimeoutMs: 150,
      watchdogIntervalMs: 50,
    })

    const errors: Array<{ taskId: string; err: unknown }> = []
    sup.on('task.error', (taskId, err) => errors.push({ taskId, err }))
    const completed: string[] = []
    sup.on('task.complete', (taskId) => completed.push(taskId))

    await sup.start()
    await new Promise((r) => setTimeout(r, 400))

    sup.dispatch(mkTask('01HX0000000000000000000099', 'after-respawn'))
    await new Promise((r) => setTimeout(r, 300))

    expect(completed).toContain('01HX0000000000000000000099')

    await sup.shutdown()
  })
})
