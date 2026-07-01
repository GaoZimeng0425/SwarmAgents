import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@shared/logger'
import type { AcceptanceCriterion, ExecutableCheck } from '@shared/types/task'

const log = createLogger({ process: 'service' }).child({ component: 'verify' })
const pexec = promisify(exec)

export type CheckResult = { criterionId: string; pass: boolean; detail: string }
export type Verdict = { verdict: 'pass' | 'fail'; results: CheckResult[]; gaps: string[] }
export type Judge = (soft: AcceptanceCriterion[], summary: string) => Promise<{ pass: boolean; gaps: string[] }>

const CHECK_TIMEOUT_MS = 120_000

async function runCheck(
  check: ExecutableCheck,
  criterionId: string,
  cwd?: string
): Promise<{ pass: boolean; detail: string }> {
  const base = cwd ?? homedir()
  if (check.kind === 'file_exists') {
    const abs = isAbsolute(check.path) ? check.path : join(base, check.path)
    const pass = existsSync(abs)
    return { pass, detail: pass ? `exists: ${abs}` : `missing: ${abs}` }
  }
  log.info({ msg: 'running command check', criterionId, command: check.command })
  const expectExit = check.expectExitCode ?? 0
  const stdoutOk = (stdout: string): boolean => (check.expectStdout ? stdout.includes(check.expectStdout) : true)
  try {
    const { stdout } = await pexec(check.command, { cwd: base, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    const pass = expectExit === 0 && stdoutOk(stdout)
    return {
      pass,
      detail: pass
        ? `exit 0${check.expectStdout ? ', stdout matched' : ''}`
        : expectExit !== 0
          ? `exit 0 (expected ${expectExit})`
          : `exit 0 but stdout missing "${check.expectStdout}"`,
    }
  } catch (e) {
    // A non-zero exit rejects; `code` carries the exit status, `stdout` the captured output.
    const code = (e as { code?: number }).code
    const stdout = (e as { stdout?: string }).stdout ?? ''
    const pass = code === expectExit && stdoutOk(stdout)
    return { pass, detail: pass ? `exit ${code} as expected` : `exit ${code ?? 'error'} (expected ${expectExit})` }
  }
}

// Run every criterion that carries a `check`, deterministically and in process.
// A thrown check is recorded as a failed criterion (logged) — never crashes verify.
export async function runHardChecks(criteria: AcceptanceCriterion[], cwd?: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const c of criteria) {
    if (!c.check) continue
    try {
      const r = await runCheck(c.check, c.id, cwd)
      results.push({ criterionId: c.id, pass: r.pass, detail: r.detail })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ msg: 'hard check threw', criterionId: c.id, err: msg })
      results.push({ criterionId: c.id, pass: false, detail: `check error: ${msg}` })
    }
  }
  return results
}

// Tolerant verdict parse: pull the first {...} block and require a boolean `pass`.
export function parseVerdict(raw: string): { pass: boolean; gaps: string[] } | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { pass?: unknown; gaps?: unknown }
    if (typeof obj.pass !== 'boolean') return null
    const gaps = Array.isArray(obj.gaps) ? obj.gaps.filter((g): g is string => typeof g === 'string') : []
    return { pass: obj.pass, gaps }
  } catch {
    return null
  }
}

// Combine hard checks (deterministic) with a soft LLM judge over the remaining
// criteria. Verdict passes iff every hard check passes AND the judge passes.
export async function verifyTask(input: {
  criteria: AcceptanceCriterion[]
  summary: string
  cwd?: string
  judge: Judge
  // When false, model-authored `kind: 'command'` checks are NOT executed (they
  // would bypass the shell permission gate); they are demoted to the soft set
  // and judged by the LLM instead. `file_exists` checks always run (read-only).
  allowCommands: boolean
}): Promise<Verdict> {
  const { criteria, summary, cwd, judge, allowCommands } = input
  // Partition criteria into the runnable-hard subset and the soft subset.
  // A criterion runs as a hard check when it has a check AND that check is
  // either file_exists (always allowed) or a command with allowCommands=true.
  // Everything else — no check, or a demoted command check — is judged.
  const runnableHard: AcceptanceCriterion[] = []
  const soft: AcceptanceCriterion[] = []
  for (const c of criteria) {
    if (!c.check) {
      soft.push(c)
      continue
    }
    if (c.check.kind === 'command' && !allowCommands) {
      log.warn({ msg: 'command check skipped (permission mode not full); judged instead', criterionId: c.id })
      soft.push(c)
      continue
    }
    runnableHard.push(c)
  }
  const hard = await runHardChecks(runnableHard, cwd)
  // Judge runs for soft criteria, or for an overall judgment when there are none.
  let judged = { pass: true, gaps: [] as string[] }
  if (soft.length > 0 || criteria.length === 0) {
    judged = await judge(soft, summary)
  }
  const hardGaps = hard.filter((r) => !r.pass).map((r) => `${r.criterionId}: ${r.detail}`)
  const softResults: CheckResult[] = soft.map((c) => ({
    criterionId: c.id,
    pass: judged.pass,
    detail: judged.pass ? 'judged satisfied' : 'judged unmet',
  }))
  const pass = hard.every((r) => r.pass) && judged.pass
  return {
    verdict: pass ? 'pass' : 'fail',
    results: [...hard, ...softResults],
    gaps: [...hardGaps, ...judged.gaps],
  }
}
