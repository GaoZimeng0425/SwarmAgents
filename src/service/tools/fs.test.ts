import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fsSpecs, isSensitivePath } from './fs'
import type { ToolRunContext } from './registry'

const ctx: ToolRunContext = {
  taskId: 't',
  spawnChild: async () => ({ childTaskId: 'c', result: { summary: '', artifacts: [] } }),
  send: () => undefined,
  requestPermission: async () => 'grant',
}

const specs = fsSpecs()
const tool = (name: string) => specs.find((s) => s.name === name)!.build(ctx)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'swarm-fs-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('isSensitivePath', () => {
  it('treats paths under the user home as non-sensitive', () => {
    expect(isSensitivePath(join(homedir(), 'Desktop', 'notes.txt'))).toBe(false)
  })
  it('treats paths outside home as sensitive', () => {
    expect(isSensitivePath('/etc/hosts')).toBe(true)
    expect(isSensitivePath('/usr/local/bin/x')).toBe(true)
  })
  it('treats relative or empty paths as sensitive (fail safe)', () => {
    expect(isSensitivePath('relative/path')).toBe(true)
    expect(isSensitivePath('')).toBe(true)
  })
})

describe('fsSpecs', () => {
  it('exposes read/list/write/edit under the fs group', () => {
    expect(specs.map((s) => `${s.group}.${s.name}`).sort()).toEqual([
      'fs.edit_file',
      'fs.list_dir',
      'fs.read_file',
      'fs.write_file',
    ])
  })

  it('reads and lists are statically low; writes escalate on sensitive paths', () => {
    const risk = (name: string) => specs.find((s) => s.name === name)!
    expect(risk('read_file').risk).toBe('low')
    expect(risk('list_dir').risk).toBe('low')
    const write = risk('write_file')
    expect(write.riskFor!({ path: join(homedir(), 'a.txt') })).toBe('low')
    expect(write.riskFor!({ path: '/etc/hosts' })).toBe('high')
    const edit = risk('edit_file')
    expect(edit.riskFor!({ path: '/System/x' })).toBe('high')
    expect(edit.riskFor!({ path: join(homedir(), 'a.txt') })).toBe('low')
  })
})

describe('read_file', () => {
  it('returns line-numbered content', async () => {
    const p = join(dir, 'three.txt')
    writeFileSync(p, 'alpha\nbeta\ngamma')
    const res = await tool('read_file').execute('c', { path: p })
    expect(res.content[0].text).toContain('1\talpha')
    expect(res.content[0].text).toContain('3\tgamma')
  })

  it('honours offset and limit (1-based lines)', async () => {
    const p = join(dir, 'five.txt')
    writeFileSync(p, 'a\nb\nc\nd\ne')
    const res = await tool('read_file').execute('c', { path: p, offset: 2, limit: 2 })
    expect(res.content[0].text).toContain('2\tb')
    expect(res.content[0].text).toContain('3\tc')
    expect(res.content[0].text).not.toContain('1\ta')
    expect(res.content[0].text).not.toContain('4\td')
  })

  it('reports a missing file as an error result, not a throw', async () => {
    const res = await tool('read_file').execute('c', { path: join(dir, 'nope.txt') })
    expect((res.details as { error?: string }).error).toBeTruthy()
    expect(res.content[0].text).toMatch(/error/i)
  })

  it('rejects a relative path', async () => {
    const res = await tool('read_file').execute('c', { path: 'rel.txt' })
    expect((res.details as { error?: string }).error).toMatch(/absolute/i)
  })
})

describe('write_file', () => {
  it('writes content to a new file', async () => {
    const p = join(dir, 'out.txt')
    const res = await tool('write_file').execute('c', { path: p, content: 'hello' })
    expect(readFileSync(p, 'utf8')).toBe('hello')
    expect((res.details as { bytes: number }).bytes).toBe(5)
  })

  it('creates missing parent directories', async () => {
    const p = join(dir, 'nested', 'deep', 'out.txt')
    await tool('write_file').execute('c', { path: p, content: 'x' })
    expect(existsSync(p)).toBe(true)
  })

  it('rejects a relative path', async () => {
    const res = await tool('write_file').execute('c', { path: 'rel.txt', content: 'x' })
    expect((res.details as { error?: string }).error).toMatch(/absolute/i)
  })
})

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    const p = join(dir, 'edit.txt')
    writeFileSync(p, 'foo bar baz')
    const res = await tool('edit_file').execute('c', { path: p, old_string: 'bar', new_string: 'BAR' })
    expect(readFileSync(p, 'utf8')).toBe('foo BAR baz')
    expect((res.details as { replacements: number }).replacements).toBe(1)
  })

  it('errors when old_string is absent', async () => {
    const p = join(dir, 'edit2.txt')
    writeFileSync(p, 'foo')
    const res = await tool('edit_file').execute('c', { path: p, old_string: 'zzz', new_string: 'y' })
    expect((res.details as { error?: string }).error).toMatch(/not found/i)
    expect(readFileSync(p, 'utf8')).toBe('foo')
  })

  it('errors on a non-unique old_string unless replace_all', async () => {
    const p = join(dir, 'edit3.txt')
    writeFileSync(p, 'x x x')
    const fail = await tool('edit_file').execute('c', { path: p, old_string: 'x', new_string: 'y' })
    expect((fail.details as { error?: string }).error).toMatch(/unique|replace_all/i)
    expect(readFileSync(p, 'utf8')).toBe('x x x')

    const ok = await tool('edit_file').execute('c', { path: p, old_string: 'x', new_string: 'y', replace_all: true })
    expect(readFileSync(p, 'utf8')).toBe('y y y')
    expect((ok.details as { replacements: number }).replacements).toBe(3)
  })

  it('errors when old_string equals new_string', async () => {
    const p = join(dir, 'edit4.txt')
    writeFileSync(p, 'foo')
    const res = await tool('edit_file').execute('c', { path: p, old_string: 'foo', new_string: 'foo' })
    expect((res.details as { error?: string }).error).toBeTruthy()
  })
})

describe('list_dir', () => {
  it('lists entries with type markers', async () => {
    const sub = join(dir, 'listme')
    mkdirSync(join(sub, 'child'), { recursive: true })
    writeFileSync(join(sub, 'file.txt'), 'x')
    const res = await tool('list_dir').execute('c', { path: sub })
    const entries = (res.details as { entries: { name: string; type: string }[] }).entries
    expect(entries.find((e) => e.name === 'file.txt')?.type).toBe('file')
    expect(entries.find((e) => e.name === 'child')?.type).toBe('dir')
  })

  it('reports a missing directory as an error result', async () => {
    const res = await tool('list_dir').execute('c', { path: join(dir, 'ghost') })
    expect((res.details as { error?: string }).error).toBeTruthy()
  })
})
