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

const userEntryEvent = {
  kind: 'entry_appended',
  sessionId: 's',
  rowId: 1,
  entry: { type: 'message', id: 'e1', parentId: null, timestamp: '', message: { role: 'user', content: 'hi' } },
}

describe('hook dispatcher', () => {
  it('fires UserPromptSubmit on entry_appended of a user message', async () => {
    const out = join(tmpdir(), `swarm-hooks-ups-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(out) }] }],
    })
    try {
      dispatch('entry_appended', userEntryEvent)
      await waitForOutfile(out)
      const parsed = JSON.parse(readFileSync(out, 'utf8'))
      expect(parsed.event).toBe('UserPromptSubmit')
      expect(parsed.hookEventName).toBe('entry_appended')
      expect(parsed.sessionId).toBe('s')
      // identity fields are promoted to the top level for shell convenience
      expect(parsed.rowId).toBe(1)
    } finally {
      cleanup()
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('does NOT fire UserPromptSubmit for a non-user (assistant) entry', async () => {
    const out = join(tmpdir(), `swarm-hooks-ups2-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(out) }] }],
    })
    try {
      dispatch('entry_appended', {
        kind: 'entry_appended',
        sessionId: 's',
        rowId: 2,
        entry: {
          type: 'message',
          id: 'e2',
          parentId: null,
          timestamp: '',
          message: { role: 'assistant', content: 'x' },
        },
      })
      await new Promise((r) => setTimeout(r, 150))
      expect(existsSync(out)).toBe(false)
    } finally {
      cleanup()
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('fires PostToolUse on tool_execution_end', async () => {
    const out = join(tmpdir(), `swarm-hooks-ptu-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(out) }] }],
    })
    try {
      dispatch('tool_execution_end', {
        kind: 'tool_execution_end',
        sessionId: 's',
        runId: 'r',
        toolCallId: 'c',
        toolName: 'run_shell',
        result: {},
        isError: false,
      })
      await waitForOutfile(out)
      expect(JSON.parse(readFileSync(out, 'utf8')).event).toBe('PostToolUse')
    } finally {
      cleanup()
      if (existsSync(out)) rmSync(out, { force: true })
    }
  })

  it('fires both Notification and PermissionRequest on permission_request', async () => {
    const nOut = join(tmpdir(), `swarm-hooks-n-${Date.now()}.json`)
    const pOut = join(tmpdir(), `swarm-hooks-p-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(nOut) }] }],
      PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(pOut) }] }],
    })
    try {
      dispatch('permission_request', {
        kind: 'permission_request',
        sessionId: 's',
        runId: 'r',
        actionId: 'a',
        risk: 'high',
        summary: 'rm',
        payload: {},
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

  it('fires Stop on agent_end', async () => {
    const stopOut = join(tmpdir(), `swarm-hooks-stop-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(stopOut) }] }],
    })
    try {
      dispatch('agent_end', { kind: 'agent_end', sessionId: 's', runId: 'r', status: 'completed' })
      await waitForOutfile(stopOut)
      expect(JSON.parse(readFileSync(stopOut, 'utf8')).event).toBe('Stop')
    } finally {
      cleanup()
      if (existsSync(stopOut)) rmSync(stopOut, { force: true })
    }
  })

  it('does not spawn anything for an event with no mapping (e.g. turn_end)', async () => {
    const sentinel = join(tmpdir(), `swarm-hooks-turn-${Date.now()}.json`)
    const { dispatch, cleanup } = setup({
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: captureCmd(sentinel) }] }],
    })
    try {
      dispatch('turn_end', { kind: 'turn_end', sessionId: 's', runId: 'r', used: {} })
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
      dispatch('agent_end', { kind: 'agent_end', sessionId: 's', runId: 'r', status: 'completed' })
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
      dispatch('agent_end', { kind: 'agent_end', sessionId: 's', runId: 'r', status: 'completed' })
    ).not.toThrow()
  })
})
