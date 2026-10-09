// Pretext accuracy spike (Phase 0 of the pretext height-estimator spec).
//
// Standalone Electron harness: loads harness.html, feeds it a corpus of real
// project prose (Chinese-heavy docs) plus synthetic edge cases, and compares
// @chenglou/pretext's predicted paragraph heights against real DOM
// offsetHeight across font/width cases. Writes results.json + prints a report.
//
// Run: <repo>/apps/desktop/node_modules/.bin/electron .   (from this dir)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, screen } from 'electron'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')

function normalizeParagraph(raw) {
  let p = raw.trim()
  if (!p || p.includes('```') || p.startsWith('|')) return ''
  p = p.replace(/^#+\s*/, '')
  p = p.replace(/^\s*[-*]\s+/gm, '')
  p = p
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  p = p.replace(/\s+/g, ' ').trim()
  const len = [...p].length
  if (len < 20 || len > 800) return ''
  return p
}

// Real prose from the repo docs — Chinese-heavy technical text, the dominant
// language of expected message content. Nothing user-private.
function collectCorpus() {
  const texts = []
  const docsDir = path.join(repoRoot, 'docs/superpowers/specs')
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith('.md')) continue
    const md = readFileSync(path.join(docsDir, file), 'utf8')
    for (const raw of md.split(/\n\s*\n/)) {
      const p = normalizeParagraph(raw)
      if (p) texts.push(p)
      if (texts.length >= 60) return texts
    }
  }
  return texts
}

const SYNTHETIC = [
  '这是一个中英混排的典型助手回复段落,包含 English terms、文件路径 src/renderer/src/app.tsx、行号 :42 和数字 12345。',
  '短句。',
  '🎉 Emoji 后接标点:测试 👍🏽、👩‍💻 和 中文🎉混排 的断行表现!',
  'Long English paragraph with technical identifiers like useVirtualList, estimateSize: () => 120, and a URL https://github.com/chenglou/pretext for wrapping behaviour.',
  '纯中文长段落用于验证 CJK 断行。pretext 依赖 Intl.Segmenter 对中文进行逐字断行,浏览器在 word-break: normal 下同样逐字断行,两者应当一致。这段文字重复一遍以加长长度。纯中文长段落用于验证 CJK 断行,两者应当一致。',
  '表格不应出现 | 但行内代码 getOffsetForIndex(index, align) 与反引号已清理。',
  'Mixed CJK/latin boundary cases: ABC-123、(括号)混排、"引号"、之乎者也 A/B 测试 50% 50GB。',
  '多空格   与   连续标点。。。以及——破折号——的断行。',
]

function computeStats(results) {
  const groups = new Map()
  for (const r of results) {
    const key = `${r.font} @${r.width}px`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const stats = []
  for (const [key, rows] of groups) {
    const drifts = rows.map((r) => Math.abs(r.drift))
    const prepares = rows.map((r) => r.prepareMs).sort((a, b) => a - b)
    stats.push({
      case: key,
      n: rows.length,
      maxDrift: +Math.max(...drifts).toFixed(2),
      avgAbsDrift: +(drifts.reduce((a, b) => a + b, 0) / rows.length).toFixed(3),
      pctWithin1px: +((drifts.filter((d) => d <= 1.01).length / rows.length) * 100).toFixed(1),
      pctWithin2px: +((drifts.filter((d) => d <= 2.01).length / rows.length) * 100).toFixed(1),
      prepareMsP50: +prepares[Math.floor(prepares.length * 0.5)].toFixed(3),
      prepareMsMax: +prepares[prepares.length - 1].toFixed(3),
      layoutMsAvg: +(rows.reduce((a, r) => a + r.layoutMs, 0) / rows.length).toFixed(4),
    })
  }
  return stats
}

function formatReport(meta, stats) {
  const lines = [
    `# Pretext accuracy spike — ${new Date().toISOString()}`,
    `DPR: ${meta.dpr}, corpus: ${meta.corpusSize} texts`,
    '',
    '| case | n | maxDrift | avgDrift | ≤1px | ≤2px | prepare p50/max ms | layout avg ms |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const s of stats) {
    lines.push(
      `| ${s.case} | ${s.n} | ${s.maxDrift} | ${s.avgAbsDrift} | ${s.pctWithin1px}% | ${s.pctWithin2px}% | ${s.prepareMsP50}/${s.prepareMsMax} | ${s.layoutMsAvg} |`
    )
  }
  return lines.join('\n')
}

async function main() {
  const win = new BrowserWindow({ width: 900, height: 700, show: true })
  await win.loadFile(path.join(here, 'harness.html'))
  const corpus = [...collectCorpus(), ...SYNTHETIC]
  const results = await win.webContents.executeJavaScript(`window.__runSpike(${JSON.stringify({ corpus })})`, true)
  const meta = { dpr: screen.getPrimaryDisplay().scaleFactor, corpusSize: corpus.length }
  const stats = computeStats(results)
  writeFileSync(path.join(here, 'results.json'), JSON.stringify({ meta, stats, results }, null, 2))
  console.log(formatReport(meta, stats))
  app.quit()
}

app.whenReady().then(main)
setTimeout(() => {
  console.error('spike timeout after 60s')
  app.exit(1)
}, 60000)
