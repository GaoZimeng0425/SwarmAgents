// scripts/check-native-feel.ts
//
// Greps src/renderer/src/ for web-y patterns the native-feel audit forbids.
// Excludes components/ui/ (shadcn primitives, audited separately).
// Run as: pnpm tsx scripts/check-native-feel.ts
import { spawnSync } from 'node:child_process'

type Rule = { pattern: string; message: string }

const RULES: Rule[] = [
  { pattern: 'cursor-pointer|cursor:\\s*pointer', message: 'C.21: native rows do not show pointer cursor' },
  { pattern: "behavior:\\s*['\"]smooth", message: "C.4: avoid behavior: 'smooth' (web idiom)" },
  { pattern: '@fontsource', message: 'D.34: use system font cascade, not web font packages' },
  { pattern: 'animate-fade|fade-in|fade-out', message: 'D.40: no route fade transitions' },
]

const EXCLUDE = ['src/renderer/src/components/ui/', 'src/renderer/src/styles/globals.css']

let failed = 0
for (const rule of RULES) {
  const args = [
    '--no-heading',
    '-n',
    rule.pattern,
    'src/renderer/src',
    ...EXCLUDE.flatMap((p) => ['-g', `!${p}**`]),
  ]
  const result = spawnSync('rg', args, { encoding: 'utf8' })
  if (result.error || result.status === null) {
    const reason = result.error?.message ?? 'rg exited with null status'
    process.stderr.write(`check-native-feel: cannot run rg — ${reason}\nInstall ripgrep and ensure it is on PATH.\n`)
    process.exit(2)
  }
  const out = (result.stdout ?? '').trim()
  if (out) {
    console.error(`\n❌ ${rule.message}`)
    console.error(out)
    failed++
  }
}

if (failed > 0) {
  console.error(`\n${failed} native-feel rule(s) violated.`)
  process.exit(1)
} else {
  console.log('✓ native-feel checks passed')
}
