import { describe, expect, it } from 'vitest'

import { pool } from '../pool'
import { runWorkflow } from '../runner'
import type { AgentFn, AgentResult } from '../types'

// --- helpers --------------------------------------------------------------

/** Build a mock AgentFn that records call order and delays per-prompt. */
function mockAgent(opts?: {
  delayMs?: number
  /** Per-prompt delay override keyed by a substring of the prompt. */
  delays?: Record<string, number>
}): { fn: AgentFn; calls: string[] } {
  const calls: string[] = []
  const fn: AgentFn = async (prompt) => {
    calls.push(prompt)
    const d = opts?.delays
      ? (Object.entries(opts.delays).find(([k]) => prompt.includes(k))?.[1] ?? opts.delayMs ?? 0)
      : (opts?.delayMs ?? 0)
    if (d > 0) await new Promise((r) => setTimeout(r, d))
    return { text: `result(${prompt})`, ok: true }
  }
  return { fn, calls }
}

const ok = (text: string): AgentResult => ({ text, ok: true })

// --- pool -----------------------------------------------------------------

describe('pool', () => {
  it('preserves input order regardless of completion order', async () => {
    // Item 0 sleeps longest; if order leaked it would come back last.
    const items = ['fast-a', 'slow', 'fast-b']
    const out = await pool(items, 3, async (item) => {
      const d = item === 'slow' ? 40 : 5
      await new Promise((r) => setTimeout(r, d))
      return item.toUpperCase()
    })
    expect(out).toEqual(['FAST-A', 'SLOW', 'FAST-B'])
  })

  it('caps concurrency and runs items in overlapping waves', async () => {
    // 3 items, concurrency 2 → must take ~2 waves, not 3 serial.
    let active = 0
    let peak = 0
    const start = Date.now()
    await pool([0, 1, 2], 2, async (i) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 30))
      active--
      return i
    })
    const elapsed = Date.now() - start
    expect(peak).toBe(2) // never exceeded the cap
    // 2 waves of 30ms ≈ 60ms; serial would be ≈90ms. Allow slack.
    expect(elapsed).toBeLessThan(75)
    expect(elapsed).toBeGreaterThanOrEqual(55)
  })

  it('degrades to serial at concurrency 1', async () => {
    let active = 0
    let peak = 0
    await pool([0, 1, 2], 1, async (i) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return i
    })
    expect(peak).toBe(1)
  })

  it('handles an empty list', async () => {
    const out = await pool([], 4, async (x) => x)
    expect(out).toEqual([])
  })
})

// --- runWorkflow end-to-end ----------------------------------------------

describe('runWorkflow', () => {
  it('pipeline fans out and converge gathers all results', async () => {
    const { fn: agentFn } = mockAgent({ delayMs: 20 })
    const files = ['auth.ts', 'db.ts', 'api.ts']
    const audits = await runWorkflow(
      'audit',
      async ({ pipeline }) => pipeline(files, (f) => agentFn(`audit ${f}`, { agentType: 'qa' }), { concurrency: 2 }),
      { agentFn }
    )
    expect(audits).toHaveLength(3)
    // Every file audited exactly once.
    for (const f of files) {
      expect(audits.some((a) => a.text === `result(audit ${f})`)).toBe(true)
    }
  })

  it('passes intermediate results between agents via JS variables, not context', async () => {
    // The second agent's prompt is built from the FIRST agent's result string.
    // This proves results live in variables the orchestrator controls.
    const { fn: agentFn } = mockAgent()
    const final = await runWorkflow(
      'chain',
      async ({ agent }) => {
        const step1 = await agent('generate a number')
        expect(step1.ok).toBe(true)
        // step1.text is a plain string — we feed it into the next prompt by hand.
        const step2 = await agent(`double this: ${step1.text}`)
        return step2
      },
      { agentFn }
    )
    expect(final.text).toBe('result(double this: result(generate a number))')
  })

  it('converge waits for ALL parallel calls before resolving', async () => {
    const { fn: agentFn } = mockAgent({
      delays: { slow: 50, quick: 5 },
    })
    const results = await runWorkflow(
      'converge',
      async ({ converge }) => converge([() => agentFn('quick-a'), () => agentFn('slow'), () => agentFn('quick-b')]),
      { agentFn }
    )
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.text).sort()).toEqual(['result(quick-a)', 'result(quick-b)', 'result(slow)'])
  })

  it('a failing agent surfaces ok:false without crashing the workflow', async () => {
    const agentFn: AgentFn = async (prompt) => {
      if (prompt.includes('boom')) {
        return { text: '', ok: false, error: 'agent exploded' }
      }
      return ok(`result(${prompt})`)
    }
    const results = await runWorkflow(
      'partial-failure',
      async ({ pipeline }) => pipeline(['a', 'boom', 'b'], (x) => agentFn(x), { concurrency: 3 }),
      { agentFn }
    )
    // All three resolve; the middle one is flagged.
    expect(results).toHaveLength(3)
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
    expect(results[1].error).toBe('agent exploded')
    expect(results[2].ok).toBe(true)
  })

  it('uses the default concurrency when pipeline omits it', async () => {
    let peak = 0
    let active = 0
    const agentFn: AgentFn = async (prompt) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return ok(`r(${prompt})`)
    }
    await runWorkflow('default-conc', async ({ pipeline }) => pipeline(['a', 'b', 'c', 'd'], (x) => agentFn(x)), {
      agentFn,
      concurrency: 2,
    })
    expect(peak).toBe(2) // respected the deps default of 2
  })
})
