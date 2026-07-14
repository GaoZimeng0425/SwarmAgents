// apps/desktop/src/renderer/src/lib/workspace/build-artifacts.ts
// Pure builder: aggregates artifacts from two sources — file paths extracted from
// the session's tool_call events (write_file/edit_file/shell redirects + MCP
// heuristic) + bilibili analyses from listArtifacts.

import type { MessageRecord } from '@shared/lib/apply-event'
import type { ArtifactEntry } from '@swarm/protocol'

export type ArtifactRow = {
  id: string
  name: string
  /** Filesystem path (file) or bvid (bilibili). Passed to openPath/bilibili.open. */
  ref: string
  /** 'session' for extracted outputs, or the 'Bilibili' label for analyses. */
  origin: string
  modifiedAt?: number
}

const PATH_LIKE = /^(\.{0,2}\/|[A-Za-z]:\\)/

function hasExtension(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.includes('.')
}

function normalizePath(p: string): string {
  // Collapse /./ and trailing slashes only (lexical-only; ../ is NOT resolved —
  // a pure fn has no fs/cwd access to resolve it).
  return p.replace(/\/\.\//g, '/').replace(/\/+$/g, '')
}

/** Pull path-like strings out of a tool_call args object (values + array values). */
function extractPathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (PATH_LIKE.test(v) && hasExtension(v)) out.push(v)
    } else if (Array.isArray(v)) {
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val)
    }
  }
  walk(args)
  return out
}

// Extract file-output targets from a shell command string: redirect targets
// (> / >>), and the destination operand of cp/mv/install/tee. Relative targets
// are resolved against cwd when available so the row ref is absolute.
function extractShellTargets(command: string, cwd?: string): string[] {
  const targets: string[] = []

  // Redirect: > file / >> file
  for (const m of command.matchAll(/>>?\s*(\S+)/g)) {
    targets.push(m[1])
  }

  // cp/mv/install <flags> <src> <dst> — the last operand is the destination.
  const cpMv = command.match(/\b(?:cp|mv|install)\s+(?:-\S+\s+)*(\S+)\s+(\S+)/)
  if (cpMv) targets.push(cpMv[2])

  // tee <flags> file
  const tee = command.match(/\btee\s+(?:-\S+\s+)*(\S+)/)
  if (tee) targets.push(tee[1])

  // Keep only targets with a file extension, then resolve against cwd.
  return targets
    .filter((t) => hasExtension(t))
    .map((t) => {
      if (t.startsWith('/')) return t
      return cwd ? `${cwd.replace(/\/$/, '')}/${t}` : t
    })
}

/** Aggregate session-extracted file outputs + bilibili analyses, deduplicated. */
export function buildArtifacts(messages: MessageRecord[], cwdArtifacts: ArtifactEntry[], cwd?: string): ArtifactRow[] {
  const seen = new Set<string>()
  const sessionRows: ArtifactRow[] = []
  for (const message of messages) {
    for (const e of message.events) {
      // Tool calls ride inside message.progress as a nested tool.call TaskEvent
      // (translator.ts wraps them there — the top-level message.tool_call kind
      // was never emitted and has been removed from the protocol).
      if (e.kind !== 'message.progress') continue
      const ev = e.event
      if (ev.kind !== 'tool.call') continue

      const tool = ev.tool
      const args = (ev as { args: unknown }).args

      // Only run_shell needs special parsing — its command string hides paths
      // from the generic extractor. Every other tool (fs, MCP, …) exposes
      // path-like values in args directly.
      const paths =
        tool === 'run_shell'
          ? extractShellTargets((args as { command?: string }).command ?? '', cwd)
          : extractPathsFromArgs(args)

      for (const p of paths) {
        const norm = normalizePath(p)
        if (seen.has(norm)) continue
        seen.add(norm)
        const name = norm.split(/[\\/]/).pop() ?? norm
        sessionRows.push({ id: `session:${norm}`, name, ref: norm, origin: 'session' })
      }
    }
  }

  const cwdRows: ArtifactRow[] = cwdArtifacts.map((a) => ({
    id: `bilibili:${a.ref}`,
    name: a.name,
    ref: a.ref,
    origin: a.origin,
    modifiedAt: a.modifiedAt,
  }))

  return [...sessionRows, ...cwdRows]
}
