// Rewrite `@/...` imports to relative paths in @swarm/ui source.
// shadcn (add/apply) emits `@/` aliases from components.json, but this package
// is consumed as raw source by apps whose own `@` alias points elsewhere, so
// `@/` never resolves in the consumer. Run this after any shadcn command.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
// `@/*` maps to `src/*` (see tsconfig.json paths).
const FROM_RE = /(from\s+["'])@\/([^"']+)(["'])/g

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(p)) relativize(p)
  }
}

function relativize(file) {
  const src = readFileSync(file, 'utf8')
  const out = src.replace(FROM_RE, (_m, pre, spec, post) => {
    let rel = relative(dirname(file), join(SRC, spec)).replaceAll('\\', '/')
    if (!rel.startsWith('.')) rel = './' + rel
    return pre + rel + post
  })
  if (out !== src) {
    writeFileSync(file, out)
    console.log('relativized', relative(SRC, file))
  }
}

walk(SRC)
