import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createHookDispatcher } from './dispatcher'
import { createHooksStore } from './store'

// Each hook command writes stdin to a unique outfile via `cat > $outfile`,
// so the test can assert the JSON payload the dispatcher piped in. Waits for
// the outfile to appear (hooks are fire-and-forget, so we poll the FS).
async function waitForOutfile(path: string, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`outfile not written: ${path}`)
    await new Promise((r) => setTimeout(r, 25))
  }
  // give the child a tick to finish writing + close
  await new Promise((r) => setTimeout(r, 30))
}

function setup(config: Record<string, unknown>): {
  dispatch: ReturnType<typeof createHookDispatcher>
  dir: string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-hooks-'))
  const hooksJson = join(dir, 'hooks.json')
  writeFileSync(hooksJson, JSON.stringify(config))
  const store = createHooksStore({ filePath: hooksJson })
  return {
    dispatch: createHookDispatcher({ store }),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// Build a hook command that captures stdin into `out`. The dispatcher writes
// the whole event payload to stdin then closes it, so `cat > out` lands it.
function captureCmd(out: string): string {
  return `cat > ${JSON.stringify(out)}`
}

describe('hook dispatcher', () => {
  it('fires UserPromptSubmit on run.created (turn)', async () => {
    const out = join(tmpdir(), `swarm-hooks-ups-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(out) }] }],
    })
    try {
      dispatch('run.created', { kind: 'run.created', sessionId: 's', runId: 'r', goal: 'hi', seq: 1, ts: 1 })
      await waitForOutfile(out)
      const parsed = JSON.parse(readFileSync(out, 'utf8'))
      expect(parsed.event).toBe('UserPromptSubmit')
      expect(parsed.hookEventName).toBe('run.created')
      expect(parsed.sessionId).toBe('s')
      expect(parsed.runId).toBe('r')
      // identity fields are promoted to the top level for shell convenience
      expect(parsed.seq).toBe(1)
    } finally {
      cleanup()
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('fires PostToolUse on run.tool_call', async () => {
    const out = join(tmpdir(), `swarm-hooks-ptu-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(out) }] }],
    })
    try {
      dispatch('run.tool_call', {
        kind: 'run.tool_call',
        sessionId: 's',
        runId: 'r',
        tool: 'run_shell',
        args: {},
        seq: 1,
        ts: 1,
      })
      await waitForOutfile(out)
      expect(JSON.parse(readFileSync(out, 'utf8')).event).toBe('PostToolUse')
    } finally {
      cleanup()
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('fires both Notification and PermissionRequest on run.permission_request', async () => {
    const nOut = join(tmpdir(), `swarm-hooks-n-${Date.now()}.json`)
    const pOut = join(tmpdir(), `swarm-hooks-p-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(nOut) }] }],
      PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(pOut) }] }],
    })
    try {
      dispatch('run.permission_request', {
        kind: 'run.permission_request',
        sessionId: 's',
        runId: 'r',
        actionId: 'a',
        risk: 'high',
        summary: 'rm',
        payload: {},
        seq: 1,
        ts: 1,
      })
      await waitForOutfile(nOut)
      await waitForOutfile(pOut)
      expect(JSON.parse(readFileSync(nOut, 'utf8')).event).toBe('Notification')
      expect(JSON.parse(readFileSync(pOut, 'utf8')).event).toBe('PermissionRequest')
    } finally {
      cleanup()
      if (existsSync(nOut)) rmSync(nOut, { force: true })
      if (existsSync(pOut)) rmSync(pOut, { force: true })
    }
  })

  it('fires Stop on run.complete of a top-level run', async () => {
    const stopOut = join(tmpdir(), `swarm-hooks-stop-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(stopOut) }] }],
    })
    try {
      // No parentRunId → top-level → Stop
      dispatch('run.complete', { kind: 'run.complete', sessionId: 's', runId: 'r', summary: 'done', seq: 1, ts: 1 })
      await waitForOutfile(stopOut)
      expect(JSON.parse(readFileSync(stopOut, 'utf8')).event).toBe('Stop')
    } finally {
      cleanup()
      if (existsSync(stopOut)) rmSync(stopOut, { force: true })
    }
  })

  it('fires SubagentStop (not Stop) on run.complete of a child run', async () => {
    const stopOut = join(tmpdir(), `swarm-hooks-stop2-${Date.now()}.json`)
    const subOut = join(tmpdir(), `swarm-hooks-sub-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(stopOut) }] }],
      SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(subOut) }] }],
    })
    try {
      // parentRunId present → child → SubagentStop, NOT Stop
      dispatch('run.complete', {
        kind: 'run.complete',
        sessionId: 's',
        runId: 'child',
        parentRunId: 'parent',
        summary: 'done',
        seq: 1,
        ts: 1,
      })
      await waitForOutfile(subOut)
      await new Promise((r) => setTimeout(r, 150))
      expect(existsSync(stopOut)).toBe(false)
      expect(JSON.parse(readFileSync(subOut, 'utf8')).event).toBe('SubagentStop')
    } finally {
      cleanup()
      if (existsSync(stopOut)) rmSync(stopOut, { force: true })
      if (existsSync(subOut)) rmSync(subOut, { force: true })
    }
  })

  it('fires SubagentStart on run.spawned', async () => {
    const out = join(tmpdir(), `swarm-hooks-ss-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      SubagentStart: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(out) }] }],
    })
    try {
      dispatch('run.spawned', { kind: 'run.spawned', sessionId: 's', runId: 'r', childRunId: 'c', seq: 1, ts: 1 })
      await waitForOutfile(out)
      expect(JSON.parse(readFileSync(out, 'utf8')).event).toBe('SubagentStart')
    } finally {
      cleanup()
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('does not spawn anything for an event with no mapping (e.g. run.usage)', async () => {
    const sentinel = join(tmpdir(), `swarm-hooks-usage-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(sentinel) }] }],
    })
    try {
      dispatch('run.usage', { kind: 'run.usage', sessionId: 's', runId: 'r', used: {}, seq: 1, ts: 1 })
      await new Promise((r) => setTimeout(r, 150))
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      cleanup()
      if (existsSync(sentinel)) rmSync(sentinel, { force: true })
    }
  })

  it('expands a leading ~ in the command to the home dir', async () => {
    // Write a capture script into the home dir and reference it via ~/.
    const scriptPath = join(homedir(), `.swarm-hooks-test-${Date.now()}.sh`)
    const out = join(tmpdir(), `swarm-hooks-tilde-${Date.now()}.json`)
    writeFileSync(scriptPath, `#!/bin/sh\ncat > ${JSON.stringify(out)}\n`, { mode: 0o755 })
    const { dispatch, cleanup } = setup({
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: `~/${basename(scriptPath)}` }] }],
    })
    try {
      dispatch('run.complete', { kind: 'run.complete', sessionId: 's', runId: 'r', summary: 'x', seq: 1, ts: 1 })
      await waitForOutfile(out)
      expect(JSON.parse(readFileSync(out, 'utf8')).event).toBe('Stop')
    } finally {
      cleanup()
      rmSync(scriptPath, { force: true })
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('tolerates a missing hooks.json (no hooks fire, no throw)', () => {
    const store = createHooksStore({ filePath: join(tmpdir(), 'definitely-missing-hooks.json') })
    const dispatch = createHookDispatcher({ store })
    expect(() =>
      dispatch('run.complete', { kind: 'run.complete', sessionId: 's', runId: 'r', summary: 'x', seq: 1, ts: 1 })
    ).not.toThrow()
  })
})
