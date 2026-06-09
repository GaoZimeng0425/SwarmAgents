import { glob, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { ToolRisk, ToolRunContext, ToolSpec } from './registry'

const MAX_OUTPUT = 16_000

// A write/edit is "sensitive" when its target is not inside the user's home
// directory. Mirrors shell's denylist philosophy: ordinary work auto-runs;
// touching system locations escalates to the permission prompt. Not a security
// boundary — the prompt is. Relative/empty paths are sensitive (fail safe).
export function isSensitivePath(path: string | undefined): boolean {
  if (!path || !isAbsolute(path)) return true
  const home = resolve(homedir()) + sep
  return !resolve(path).startsWith(home)
}

const writeRisk = (args: unknown): ToolRisk =>
  isSensitivePath((args as { path?: string }).path) ? 'high' : 'low'

type Result = { content: [{ type: 'text'; text: string }]; details: Record<string, unknown> }
const ok = (text: string, details: Record<string, unknown> = {}): Result => ({
  content: [{ type: 'text', text }],
  details,
})
const err = (message: string): Result => ok(`error: ${message}`, { error: message })

const truncate = (text: string): string =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[output truncated]` : text

const ReadParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to read.' }),
  offset: Type.Optional(Type.Number({ description: '1-based line number to start from (default 1).' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to return.' })),
})

function readSpec(): ToolSpec {
  return {
    group: 'fs',
    name: 'read_file',
    risk: 'low',
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'read_file',
      label: 'Read file',
      description:
        'Read a UTF-8 text file and return its contents with 1-based line numbers. Supports `offset`/`limit` to page through large files. Requires an absolute path.',
      parameters: ReadParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { path: string; offset?: number; limit?: number }
        if (!isAbsolute(p.path)) return err(`path must be absolute: ${p.path}`)
        let raw: string
        try {
          raw = await readFile(p.path, 'utf8')
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const lines = raw.split('\n')
        const start = Math.max(1, p.offset ?? 1)
        const end = p.limit != null ? start + p.limit - 1 : lines.length
        const body = lines
          .slice(start - 1, end)
          .map((line, i) => `${start + i}\t${line}`)
          .join('\n')
        return ok(truncate(body), { path: p.path, lines: lines.length })
      },
    }),
  }
}

const WriteParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to write. Parent directories are created if missing.' }),
  content: Type.String({ description: 'Full file contents to write (overwrites any existing file).' }),
})

function writeSpec(): ToolSpec {
  return {
    group: 'fs',
    name: 'write_file',
    risk: 'low',
    riskFor: writeRisk,
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'write_file',
      label: 'Write file',
      description:
        'Write (overwrite or create) a UTF-8 text file, creating parent directories as needed. Requires an absolute path.',
      parameters: WriteParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { path: string; content: string }
        if (!isAbsolute(p.path)) return err(`path must be absolute: ${p.path}`)
        try {
          await mkdir(dirname(p.path), { recursive: true })
          await writeFile(p.path, p.content, 'utf8')
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const bytes = Buffer.byteLength(p.content, 'utf8')
        return ok(`wrote ${bytes} bytes to ${p.path}`, { path: p.path, bytes })
      },
    }),
  }
}

const EditParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the file to edit.' }),
  old_string: Type.String({ description: 'Exact text to replace. Must be unique unless replace_all is set.' }),
  new_string: Type.String({ description: 'Replacement text. Must differ from old_string.' }),
  replace_all: Type.Optional(Type.Boolean({ description: 'Replace every occurrence instead of requiring uniqueness.' })),
})

function editSpec(): ToolSpec {
  return {
    group: 'fs',
    name: 'edit_file',
    risk: 'low',
    riskFor: writeRisk,
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'edit_file',
      label: 'Edit file',
      description:
        'Replace an exact string in a file. `old_string` must match uniquely unless `replace_all` is set. Requires an absolute path.',
      parameters: EditParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { path: string; old_string: string; new_string: string; replace_all?: boolean }
        if (!isAbsolute(p.path)) return err(`path must be absolute: ${p.path}`)
        if (p.old_string === p.new_string) return err('old_string and new_string are identical')
        let raw: string
        try {
          raw = await readFile(p.path, 'utf8')
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const count = raw.split(p.old_string).length - 1
        if (count === 0) return err(`old_string not found in ${p.path}`)
        if (count > 1 && !p.replace_all)
          return err(`old_string is not unique (${count} matches); add context or set replace_all`)
        const next = p.replace_all ? raw.split(p.old_string).join(p.new_string) : raw.replace(p.old_string, p.new_string)
        try {
          await writeFile(p.path, next, 'utf8')
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const replacements = p.replace_all ? count : 1
        return ok(`replaced ${replacements} occurrence(s) in ${p.path}`, { path: p.path, replacements })
      },
    }),
  }
}

const ListParams = Type.Object({
  path: Type.String({ description: 'Absolute path to the directory to list.' }),
})

const entryType = (d: { isDirectory(): boolean; isSymbolicLink(): boolean }): string =>
  d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file'

function listSpec(): ToolSpec {
  return {
    group: 'fs',
    name: 'list_dir',
    risk: 'low',
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'list_dir',
      label: 'List directory',
      description: 'List the entries of a directory with their type (file/dir/symlink). Requires an absolute path.',
      parameters: ListParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { path: string }
        if (!isAbsolute(p.path)) return err(`path must be absolute: ${p.path}`)
        let dirents: Awaited<ReturnType<typeof readdir>>
        try {
          dirents = await readdir(p.path, { withFileTypes: true })
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        const entries = dirents
          .map((d) => ({ name: d.name, type: entryType(d) }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const text = entries.map((e) => `[${e.type[0]}] ${e.name}`).join('\n')
        return ok(truncate(text) || '(empty)', { path: p.path, entries })
      },
    }),
  }
}

const MAX_GLOB = 1000

const GlobParams = Type.Object({
  pattern: Type.String({ description: 'Glob pattern relative to `path`, e.g. "**/*.ts".' }),
  path: Type.Optional(Type.String({ description: 'Absolute base directory to search (default: home directory).' })),
})

function globSpec(): ToolSpec {
  return {
    group: 'fs',
    name: 'glob',
    risk: 'low',
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'glob',
      label: 'Find files',
      description:
        'Find files matching a glob pattern under a base directory. Returns absolute paths. Use a specific pattern to keep results focused.',
      parameters: GlobParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { pattern: string; path?: string }
        const base = p.path ?? homedir()
        if (!isAbsolute(base)) return err(`path must be absolute: ${base}`)
        const matches: string[] = []
        try {
          for await (const m of glob(p.pattern, { cwd: base })) {
            matches.push(resolve(base, m))
            if (matches.length >= MAX_GLOB) break
          }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
        matches.sort()
        const text = matches.join('\n')
        return ok(truncate(text) || '(no matches)', { count: matches.length, truncated: matches.length >= MAX_GLOB })
      },
    }),
  }
}

const MAX_GREP_MATCHES = 200
const MAX_GREP_FILES = 2000
const MAX_GREP_FILE_BYTES = 2_000_000

const GrepParams = Type.Object({
  pattern: Type.String({ description: 'Regular expression to search for, tested per line.' }),
  path: Type.Optional(Type.String({ description: 'Absolute base directory to search (default: home directory).' })),
  glob: Type.Optional(Type.String({ description: 'Glob to restrict which files are searched (default "**/*").' })),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive matching.' })),
})

function grepSpec(): ToolSpec {
  return {
    group: 'fs',
    name: 'grep',
    risk: 'low',
    source: 'builtin',
    build: (_ctx: ToolRunContext): AgentTool => ({
      name: 'grep',
      label: 'Search file contents',
      description:
        'Search file contents by regular expression and return matching `path:line: text`. Binary and oversized files are skipped.',
      parameters: GrepParams,
      execute: async (_id: string, params: unknown) => {
        const p = params as { pattern: string; path?: string; glob?: string; ignoreCase?: boolean }
        const base = p.path ?? homedir()
        if (!isAbsolute(base)) return err(`path must be absolute: ${base}`)
        let re: RegExp
        try {
          re = new RegExp(p.pattern, p.ignoreCase ? 'i' : '')
        } catch (e) {
          return err(`invalid regex: ${e instanceof Error ? e.message : String(e)}`)
        }

        const matches: Array<{ file: string; line: number; text: string }> = []
        let scanned = 0
        try {
          for await (const rel of glob(p.glob ?? '**/*', { cwd: base })) {
            if (matches.length >= MAX_GREP_MATCHES || scanned >= MAX_GREP_FILES) break
            const abs = resolve(base, rel)
            let info: Awaited<ReturnType<typeof stat>>
            try {
              info = await stat(abs)
            } catch {
              continue
            }
            if (!info.isFile() || info.size > MAX_GREP_FILE_BYTES) continue
            let content: string
            try {
              content = await readFile(abs, 'utf8')
            } catch {
              continue
            }
            if (content.includes(String.fromCharCode(0))) continue // skip binary files
            scanned++
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                matches.push({ file: abs, line: i + 1, text: lines[i].slice(0, 400) })
                if (matches.length >= MAX_GREP_MATCHES) break
              }
            }
          }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }

        const text = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')
        return ok(truncate(text) || '(no matches)', {
          count: matches.length,
          truncated: matches.length >= MAX_GREP_MATCHES,
        })
      },
    }),
  }
}

export function fsSpecs(): ToolSpec[] {
  return [readSpec(), writeSpec(), editSpec(), listSpec(), globSpec(), grepSpec()]
}
