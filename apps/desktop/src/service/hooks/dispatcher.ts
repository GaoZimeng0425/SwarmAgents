// Claude-Code-style hook dispatcher: when a v3 AgentWireEvent fires, look up any
// matching command hooks in hooks.json and spawn them (fire-and-forget), with
// the event payload piped to stdin as a single-line JSON document. Pure
// notification semantics — a hook's exit code / output never influences the
// run; failures are warn-logged and swallowed (a broken notification must not
// break the agent loop).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createLogger } from '@shared/logger'
import type { HooksFile } from '@swarm/protocol'

import type { HooksStore } from './store'

const log = createLogger({ process: 'service' }).child({ component: 'hooks-dispatcher' })

const HOOK_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 16_000

// Maps a v3 AgentWireEvent kind to the Claude-Code-style event name(s) it fires.
// Verified against the official hook reference (code.claude.com/docs/en/hooks):
//   - UserPromptSubmit: "user submits a prompt"       → entry_appended (user message)
//   - PostToolUse:      "after a tool is called"       → tool_execution_end
//   - Notification:     "requires user attention"      → permission_request
//   - PermissionRequest:"a permission request is made" → permission_request
//   - Stop:             "Claude finishes responding"   → agent_end
// entry_appended and tool_execution_end need payload inspection, so they are
// handled specially below rather than via this static table. v3 child runs
// execute in hidden child sessions, so the wire carries no parent/child linkage —
// SubagentStart/SubagentStop are not mapped. Events with no clean counterpart
// (turn_*, message_*, agent_start) are intentionally NOT mapped.
const WIRE_KIND_TO_CLAUDE: Record<string, string[]> = {
  permission_request: ['Notification', 'PermissionRequest'],
  agent_end: ['Stop'],
}

export type HookDispatcher = (eventName: string, payload: unknown) => void

export function createHookDispatcher(opts: { store: HooksStore }): HookDispatcher {
  const { store } = opts
  return (eventName, payload) => {
    const obj = (payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>) } : {}) as {
      sessionId?: string
      runId?: string
      rowId?: number
      kind?: string
      entry?: { type?: string; message?: { role?: string } }
    }

    let claudeNames: string[]
    if (eventName === 'entry_appended') {
      // UserPromptSubmit fires only for a user-message entry (the turn's input),
      // not for the assistant/tool/custom entries that also ride entry_appended.
      const entry = obj.entry
      if (entry?.type !== 'message' || entry.message?.role !== 'user') return
      claudeNames = ['UserPromptSubmit']
    } else if (eventName === 'tool_execution_end') {
      // PostToolUse fires after a tool completes — not on start/update.
      claudeNames = ['PostToolUse']
    } else {
      const names = WIRE_KIND_TO_CLAUDE[eventName]
      if (!names) return
      claudeNames = names
    }

    if (claudeNames.length === 0) return

    const config: HooksFile = store.get()
    for (const claudeName of claudeNames) {
      const matchers = config[claudeName]
      if (!matchers || matchers.length === 0) continue
      for (const m of matchers) {
        // TODO: matcher is currently ignored — every matcher block fires on
        // every event of its type. Filter by matcher (tool name, etc.) once a
        // concrete filtering semantics is needed.
        for (const entry of m.hooks) {
          if (entry.type !== 'command') continue
          void runHookCommand(claudeName, entry.command, eventName, obj)
        }
      }
    }
  }
}

/** Expand a leading `~` to the home dir; spawn does not do this itself. */
function expandTilde(cmd: string): string {
  if (cmd.startsWith('~/')) return join(homedir(), cmd.slice(2))
  if (cmd === '~') return homedir()
  return cmd
}

// Inlined join() to avoid pulling node:path just for this — keeps the module
// dependency-free apart from child_process/os.
function join(base: string, rest: string): string {
  return `${base.replace(/\/$/, '')}/${rest}`
}

async function runHookCommand(
  claudeName: string,
  command: string,
  hookEventName: string,
  ctx: {
    sessionId?: string
    runId?: string
    rowId?: number
    kind?: string
  }
): Promise<void> {
  // The stdin payload mirrors Claude Code's shape: the Claude event name plus
  // the full internal AgentWireEvent under hookEventName, with identity fields
  // promoted to the top level for easy access in shell scripts. `event` is
  // always the Claude name (it wins over any payload field of the same name).
  const stdinPayload = { ...ctx, event: claudeName, hookEventName }
  const stdinJson = JSON.stringify(stdinPayload)

  log.info({
    msg: 'hook dispatched',
    claudeName,
    hookEventName,
    command,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
  })

  return new Promise<void>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const done = (err?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err || timedOut || stderr) {
        log.warn({
          msg: 'hook command finished',
          claudeName,
          hookEventName,
          command,
          timedOut,
          stderr: stderr.slice(0, MAX_OUTPUT),
          stdoutTail: stdout.slice(-MAX_OUTPUT),
          err,
        })
      }
      resolve()
    }

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn('/bin/sh', ['-c', expandTilde(command)], {
        env: process.env,
        cwd: homedir(),
      })
    } catch (err) {
      done(err instanceof Error ? err.message : String(err))
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, HOOK_TIMEOUT_MS)

    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', (err) => done(err.message))

    proc.on('close', () => done())

    // Feed the event JSON to stdin, then close it so the child sees EOF.
    try {
      proc.stdin.write(stdinJson)
      proc.stdin.end()
    } catch {
      // stdin write after an early close is harmless; the close handler runs.
    }
  })
}
