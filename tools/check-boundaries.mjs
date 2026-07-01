#!/usr/bin/env node
import { execSync } from 'node:child_process'
// Fails if @swarm/protocol or @swarm/shared import anything platform-bound.
// Run from the repo root: `node tools/check-boundaries.mjs`
import { readFileSync } from 'node:fs'

const FORBIDDEN = [
  /^electron/,
  /^better-sqlite3$/,
  /^sqlite-vec$/,
  /^sherpa-onnx-node/,
  /^node:/,
  /^child_process$/,
  /^path$/,
  /^fs$/,
  /^os$/,
  /@anthropic-ai\//,
  /@modelcontextprotocol\//,
  /^react$/,
  /^react-dom$/,
  /^react-native$/,
]

let bad = 0
for (const pkg of ['protocol', 'shared']) {
  let files = []
  try {
    files = execSync(`git ls-files packages/${pkg}/src`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    /* no files yet */
  }
  for (const f of files) {
    if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('@swarm/')) continue
      if (FORBIDDEN.some((re) => re.test(spec))) {
        console.error(`BOUNDARY VIOLATION: ${f} imports "${spec}"`)
        bad++
      }
    }
  }
}
if (bad) {
  console.error(`\n${bad} boundary violation(s) in @swarm/* packages.`)
  process.exit(1)
}
console.log('Boundary check OK — no forbidden imports in @swarm/* packages.')
