#!/usr/bin/env node
import { execSync } from 'node:child_process'
// Fails if @swarm/protocol, @swarm/shared, or @swarm/ui import anything
// platform-bound. @swarm/ui may use React/web libs but must stay Electron- and
// native-free. Run from the repo root: `node tools/check-boundaries.mjs`
import { readFileSync } from 'node:fs'

// Platform-agnostic baseline: forbids Electron, native modules, node builtins,
// provider SDKs, and React Native. React/web libs are allowed.
const FORBIDDEN_PLATFORM = [
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
  /^react-native$/,
]

// Stricter rule for protocol/shared: they are pure logic consumed by non-React
// contexts (e.g. the Electron main process), so React is also forbidden.
const FORBIDDEN_NO_REACT = [...FORBIDDEN_PLATFORM, /^react$/, /^react-dom$/]

const RULES = {
  protocol: FORBIDDEN_NO_REACT,
  shared: FORBIDDEN_NO_REACT,
  ui: FORBIDDEN_PLATFORM,
}

let bad = 0
for (const [pkg, forbidden] of Object.entries(RULES)) {
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
      if (forbidden.some((re) => re.test(spec))) {
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
