// Claude-Code-style hook dispatcher: when a run.* event fires, look up any
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

// Maps an internal run.* kind to the Claude-Code-style event name(s) it should
// fire. A function (not a static list) so terminal events can route to Stop vs
// SubagentStop based on whether the run is a child (has parentRunId). Verified
// against the official hook reference (code.claude.com/docs/en/hooks):
//   - UserPromptSubmit: "user submits a prompt"        → run.created (turn)
//   - PostToolUse:      "after a tool is called"        → run.tool_call
//   - Notification:     "requires user attention"       → run.permission_request
//   - PermissionRequest:"a permission request is made"  → run.permission_request
//   - Stop:             "Claude finishes responding"    → terminal of a top-level run
//   - SubagentStart:    (child run spawned)             → run.spawned
//   - SubagentStop:     (child run finished)            → terminal of a child run
// Events with no clean lifecycle counterpart here (SessionStart/SessionEnd,
// PreCompact, …) are intentionally NOT mapped — see docs/design notes.
const RUN_KIND_TO_CLAUDE: Record<string, (ctx: { parentRunId?: string }) => string[]> = {
  'run.created': () => ['UserPromptSubmit'],
  'run.tool_call': () => ['PostToolUse'],
  'run.permission_request': () => ['Notification', 'PermissionRequest'],
  'run.spawned': () => ['SubagentStart'],
  'run.complete': (ctx) => [ctx.parentRunId ? 'SubagentStop' : 'Stop'],
  'run.error': (ctx) => [ctx.parentRunId ? 'SubagentStop' : 'Stop'],
}

export type HookDispatcher = (eventName: string, payload: unknown) => void

export function createHookDispatcher(opts: { store: HooksStore }): HookDispatcher {
  const { store } = opts
  return (eventName, payload) => {
    // eventName here is the internal run.* kind; resolve the Claude names it
    // should trigger. Terminal kinds route to Stop vs SubagentStop via the
    // parentRunId-aware mapper below.
    const mapFor = RUN_KIND_TO_CLAUDE[eventName]
    if (!mapFor) return

    const config: HooksFile = store.get()
    const obj = (payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>) } : {}) as {
      sessionId?: string
      runId?: string
      parentRunId?: string
      seq?: number
      ts?: number
      kind?: string
    }
    const claudeNames = mapFor({ parentRunId: obj.parentRunId })
    if (claudeNames.length === 0) return

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
    parentRunId?: string
    seq?: number
    ts?: number
    kind?: string
  }
): Promise<void> {
  // The stdin payload mirrors Claude Code's shape: the Claude event name plus
  // the full internal run.* event under hookEventName, with identity fields
  // promoted to the top level for easy access in shell scripts. `event` is
  // always the Claude name (it wins over any payload field of the same name,
  // e.g. run.progress's nested TaskEvent `event`).
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
