import { describe, expect, it, vi } from 'vitest'

import { parseVerdict, runHardChecks, verifyTask } from './verify'

describe('parseVerdict', () => {
  it('parses a bare json object', () => {
    expect(parseVerdict('{"pass": true, "gaps": []}')).toEqual({ pass: true, gaps: [] })
  })
  it('extracts json embedded in prose', () => {
    expect(parseVerdict('Here is my verdict:\n{"pass": false, "gaps": ["no tests"]}\nDone.')).toEqual({
      pass: false,
      gaps: ['no tests'],
    })
  })
  it('returns null when no parseable verdict', () => {
    expect(parseVerdict('looks good to me')).toBeNull()
  })
  it('returns null when pass is not a boolean', () => {
    expect(parseVerdict('{"pass": "yes"}')).toBeNull()
  })
})

describe('runHardChecks', () => {
  it('passes a command that exits 0', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'echo', check: { kind: 'command', command: 'exit 0' } }])
    expect(r).toEqual([{ criterionId: 'c1', pass: true, detail: expect.any(String) }])
  })
  it('fails a command that exits non-zero', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'fail', check: { kind: 'command', command: 'exit 3' } }])
    expect(r[0].pass).toBe(false)
  })
  it('honors a non-zero expectExitCode', async () => {
    const r = await runHardChecks([
      { id: 'c1', description: 'expect 3', check: { kind: 'command', command: 'exit 3', expectExitCode: 3 } },
    ])
    expect(r[0].pass).toBe(true)
  })
  it('checks stdout substring', async () => {
    const ok = await runHardChecks([
      { id: 'c1', description: 'say hi', check: { kind: 'command', command: 'echo hello', expectStdout: 'hello' } },
    ])
    expect(ok[0].pass).toBe(true)
    const bad = await runHardChecks([
      { id: 'c2', description: 'say hi', check: { kind: 'command', command: 'echo hello', expectStdout: 'bye' } },
    ])
    expect(bad[0].pass).toBe(false)
  })
  it('checks file_exists against cwd', async () => {
    const r = await runHardChecks(
      [{ id: 'c1', description: 'pkg', check: { kind: 'file_exists', path: 'package.json' } }],
      process.cwd()
    )
    expect(r[0].pass).toBe(true)
  })
  it('skips criteria without a check', async () => {
    const r = await runHardChecks([{ id: 'c1', description: 'reads well' }])
    expect(r).toEqual([])
  })
})

describe('verifyTask', () => {
  it('passes when all hard checks pass and judge passes', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    const v = await verifyTask({
      criteria: [
        { id: 'c1', description: 'tests', check: { kind: 'command', command: 'exit 0' } },
        { id: 'c2', description: 'reads well' },
      ],
      summary: 'done',
      judge,
      allowCommands: true,
    })
    expect(v.verdict).toBe('pass')
    expect(judge).toHaveBeenCalledWith([{ id: 'c2', description: 'reads well' }], 'done')
  })
  it('fails when a hard check fails, even if judge passes', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    const v = await verifyTask({
      criteria: [{ id: 'c1', description: 'tests', check: { kind: 'command', command: 'exit 1' } }],
      summary: 'done',
      judge,
      allowCommands: true,
    })
    expect(v.verdict).toBe('fail')
    expect(v.gaps.some((g) => g.startsWith('c1:'))).toBe(true)
  })
  it('does not call the judge when every criterion has a check', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    await verifyTask({
      criteria: [{ id: 'c1', description: 'tests', check: { kind: 'command', command: 'exit 0' } }],
      summary: 'done',
      judge,
      allowCommands: true,
    })
    expect(judge).not.toHaveBeenCalled()
  })
  it('runs the judge for overall judgment when there are no criteria', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: false, gaps: ['nothing produced'] })
    const v = await verifyTask({ criteria: [], summary: 'idle', judge, allowCommands: true })
    expect(judge).toHaveBeenCalled()
    expect(v.verdict).toBe('fail')
  })
  it('demotes a command check to the judge when allowCommands is false', async () => {
    // The command would exit 1 (a hard failure) if executed. With allowCommands
    // false it must NOT run; the verdict follows the judge (pass) instead.
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    const criterion = { id: 'c1', description: 'tests', check: { kind: 'command' as const, command: 'exit 1' } }
    const v = await verifyTask({
      criteria: [criterion],
      summary: 'done',
      judge,
      allowCommands: false,
    })
    // No command ran, so the verdict follows the (passing) judge, not the exit 1.
    expect(v.verdict).toBe('pass')
    // The demoted command criterion is sent to the judge in its soft list.
    expect(judge).toHaveBeenCalledWith([criterion], 'done')
  })
  it('still runs a file_exists check when allowCommands is false', async () => {
    const judge = vi.fn().mockResolvedValue({ pass: true, gaps: [] })
    const v = await verifyTask({
      criteria: [{ id: 'c1', description: 'pkg', check: { kind: 'file_exists', path: 'package.json' } }],
      summary: 'done',
      cwd: process.cwd(),
      judge,
      allowCommands: false,
    })
    expect(v.verdict).toBe('pass')
    expect(v.results.some((r) => r.criterionId === 'c1' && r.detail.startsWith('exists:'))).toBe(true)
    // file_exists has no soft entry and is the only criterion, so the judge is not called.
    expect(judge).not.toHaveBeenCalled()
  })
})
