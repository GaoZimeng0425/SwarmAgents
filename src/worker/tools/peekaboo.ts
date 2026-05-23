import { spawn } from 'node:child_process'

const PEEKABOO_BIN = process.env.PEEKABOO_BIN ?? 'peekaboo'

export type PeekabooResult =
  | { ok: true; stdout: string; parsed?: unknown }
  | { ok: false; error: string; stderr?: string }

/**
 * Spawn the Peekaboo CLI and capture its output. Phase C v1 — direct CLI
 * subprocess; in a future iteration the Main process will own a Peekaboo MCP
 * server child and route tool.call IPC through it.
 *
 * Returns parsed JSON when `--json` is among the args.
 */
export function runPeekaboo(args: string[], timeoutMs = 20_000): Promise<PeekabooResult> {
  return new Promise((resolve) => {
    const proc = spawn(PEEKABOO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ ok: false, error: `peekaboo timed out after ${timeoutMs}ms`, stderr })
    }, timeoutMs)
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        error: `failed to spawn peekaboo: ${err.message}. Is the CLI installed and on PATH? Override with PEEKABOO_BIN env.`,
      })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, error: `peekaboo exited with code ${code}`, stderr })
        return
      }
      // Try to parse JSON; pass it through raw on failure.
      try {
        const parsed = JSON.parse(stdout) as unknown
        resolve({ ok: true, stdout, parsed })
      } catch {
        resolve({ ok: true, stdout })
      }
    })
  })
}

/** Summarise the `peekaboo see --json` output into a compact string the LLM can reason about. */
export function summariseSeeOutput(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return JSON.stringify(parsed)
  const data = parsed as {
    success?: boolean
    error?: { message?: string }
    data?: {
      screenshot_path?: string
      ui_elements?: Array<{ id?: string; role?: string; title?: string; value?: string }>
      session_id?: string
    }
  }
  if (data.success === false) {
    return `peekaboo see failed: ${data.error?.message ?? 'unknown'}`
  }
  const ui = data.data?.ui_elements ?? []
  const path = data.data?.screenshot_path ?? '(no path)'
  if (ui.length === 0) {
    return `Screenshot saved to ${path}. No UI elements detected.`
  }
  const top = ui.slice(0, 25).map((el) => {
    const title = el.title ?? el.value ?? ''
    return `  ${el.id ?? '?'} ${el.role ?? '?'}${title ? ': ' + title : ''}`
  })
  return `Screenshot saved to ${path}. ${ui.length} UI elements (showing first ${top.length}):\n${top.join('\n')}`
}
