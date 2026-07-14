// Claude-Code-style hook dispatcher: when a message.* event fires, look up any
// matching command hooks in hooks.json and spawn them (fire-and-forget), with
// the event payload piped to stdin as a single-line JSON document. Pure
// notification semantics — a hook's exit code / output never influences the
// message; failures are warn-logged and swallowed (a broken notification must not
// break the agent loop).
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createLogger } from '@shared/logger'
import type { HooksFile } from '@swarm/protocol'

import type { HooksStore } from './store'

const log = createLogger({ process: 'service' }).child({ component: 'hooks-dispatcher' })

const HOOK_TIMEOUT_MS = 30_000
const MAX_OUTPUT = 16_000

// Maps an internal message.* kind to the Claude-Code-style event name(s) it should
// fire. A function (not a static list) so terminal events can route to Stop vs
// SubagentStop based on whether the message is a child (has parentMessageId). Verified
// against the official hook reference (code.claude.com/docs/en/hooks):
//   - UserPromptSubmit: "user submits a prompt"        → message.created (turn)
//   - PostToolUse:      "after a tool is called"        → message.progress (tool.call)
//   - Notification:     "requires user attention"       → message.permission_request
//   - PermissionRequest:"a permission request is made"  → message.permission_request
//   - Stop:             "Claude finishes responding"    → terminal of a top-level message
//   - SubagentStart:    (child message spawned)         → message.spawned
//   - SubagentStop:     (child message finished)        → terminal of a child message
// Events with no clean lifecycle counterpart here (SessionStart/SessionEnd,
// PreCompact, …) are intentionally NOT mapped — see docs/design notes.
const MESSAGE_KIND_TO_CLAUDE: Record<string, (ctx: { parentMessageId?: string }) => string[]> = {
  'message.created': () => ['UserPromptSubmit'],
  'message.permission_request': () => ['Notification', 'PermissionRequest'],
  'message.spawned': () => ['SubagentStart'],
  'message.complete': (ctx) => [ctx.parentMessageId ? 'SubagentStop' : 'Stop'],
  'message.error': (ctx) => [ctx.parentMessageId ? 'SubagentStop' : 'Stop'],
}

export type HookDispatcher = (eventName: string, payload: unknown) => void

export function createHookDispatcher(opts: { store: HooksStore }): HookDispatcher {
  const { store } = opts
  return (eventName, payload) => {
    const obj = (payload && typeof payload === 'object' ? { ...(payload as Record<string, unknown>) } : {}) as {
      sessionId?: string
      messageId?: string
      parentMessageId?: string
      seq?: number
      ts?: number
      kind?: string
    }

    // Tool calls ride inside message.progress as a nested tool.call TaskEvent.
    // PostToolUse fires on tool.call — not on every progress event.
    let claudeNames: string[]
    if (eventName === 'message.progress') {
      const event = (obj as { event?: { kind?: string } }).event
      if (event?.kind !== 'tool.call') return
      claudeNames = ['PostToolUse']
    } else {
      // eventName here is the internal message.* kind; resolve the Claude names it
      // should trigger. Terminal kinds route to Stop vs SubagentStop via the
      // parentMessageId-aware mapper below.
      const mapFor = MESSAGE_KIND_TO_CLAUDE[eventName]
      if (!mapFor) return
      claudeNames = mapFor({ parentMessageId: obj.parentMessageId })
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
    messageId?: string
    parentMessageId?: string
    seq?: number
    ts?: number
    kind?: string
  }
): Promise<void> {
  // The stdin payload mirrors Claude Code's shape: the Claude event name plus
  // the full internal message.* event under hookEventName, with identity fields
  // promoted to the top level for easy access in shell scripts. `event` is
  // always the Claude name (it wins over any payload field of the same name,
  // e.g. message.progress's nested TaskEvent `event`).
  const stdinPayload = { ...ctx, event: claudeName, hookEventName }
  const stdinJson = JSON.stringify(stdinPayload)

  log.info({
    msg: 'hook dispatched',
    claudeName,
    hookEventName,
    command,
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
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
