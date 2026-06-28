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

async function runCheck(check: ExecutableCheck, cwd?: string): Promise<{ pass: boolean; detail: string }> {
  const base = cwd ?? homedir()
  if (check.kind === 'file_exists') {
    const abs = isAbsolute(check.path) ? check.path : join(base, check.path)
    const pass = existsSync(abs)
    return { pass, detail: pass ? `exists: ${abs}` : `missing: ${abs}` }
  }
  const expectExit = check.expectExitCode ?? 0
  const stdoutOk = (stdout: string): boolean => (check.expectStdout ? stdout.includes(check.expectStdout) : true)
  try {
    const { stdout } = await pexec(check.command, { cwd: base, timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    const pass = expectExit === 0 && stdoutOk(stdout)
    return {
      pass,
      detail: pass
        ? `exit 0${check.expectStdout ? ', stdout matched' : ''}`
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
      const r = await runCheck(c.check, cwd)
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
}): Promise<Verdict> {
  const { criteria, summary, cwd, judge } = input
  const hard = await runHardChecks(criteria, cwd)
  const soft = criteria.filter((c) => !c.check)
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
