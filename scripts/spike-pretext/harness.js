// Renderer-side measurement: for each font/width case, render every corpus
// paragraph as a real DOM node and compare its offsetHeight with
// pretext.prepare()+layout()'s prediction. The DOM reading is ground truth.
import { layout, prepare } from './node_modules/@chenglou/pretext/dist/layout.js'

// Font strategies under test (decision point D2 of the spec):
// - stack-as-css: the app's current -apple-system... stack (what we'd ship
//   with zero visual change if accurate enough)
// - named fallbacks a pinned-font strategy could adopt
const FONT_CASES = [
  {
    id: 'stack-as-css',
    css: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  { id: 'system-ui', css: 'system-ui' },
  { id: 'helvetica-neue', css: "'Helvetica Neue'" },
  { id: 'hiragino-sans-gb', css: "'Hiragino Sans GB'" },
  { id: 'sf-pro-text', css: "'SF Pro Text'" },
]

const WIDTHS = [736, 500, 320]

function runCase(corpus, fontCase, width) {
  const stage = document.getElementById('stage')
  const probe = document.createElement('div')
  probe.style.cssText = [
    'position:absolute',
    'left:-9999px',
    'top:0',
    `width:${width}px`,
    `font-family:${fontCase.css}`,
    'font-size:14px',
    'line-height:20px',
    'letter-spacing:normal',
    'white-space:normal',
    'word-break:normal',
    'overflow-wrap:break-word',
  ].join(';')
  stage.appendChild(probe)

  const cs = getComputedStyle(probe)
  const lineHeight = Number.parseFloat(cs.lineHeight)
  const fontSpec = `${cs.fontWeight} ${cs.fontSize} ${fontCase.css}`
  // Warm shared caches so timing rows measure steady-state cost.
  prepare('warmup 段落 warmup', fontSpec, { whiteSpace: 'normal', wordBreak: 'normal' })

  const rows = []
  for (const text of corpus) {
    probe.textContent = text
    const domHeight = probe.offsetHeight
    const t0 = performance.now()
    const prepared = prepare(text, fontSpec, { whiteSpace: 'normal', wordBreak: 'normal' })
    const t1 = performance.now()
    const { height } = layout(prepared, width, lineHeight)
    const t2 = performance.now()
    rows.push({
      font: fontCase.id,
      width,
      textLen: [...text].length,
      domHeight,
      predicted: Number.parseFloat(height.toFixed(2)),
      drift: Number.parseFloat((height - domHeight).toFixed(2)),
      prepareMs: Number.parseFloat((t1 - t0).toFixed(3)),
      layoutMs: Number.parseFloat((t2 - t1).toFixed(4)),
    })
  }
  probe.remove()
  return rows
}

window.__runSpike = ({ corpus }) => {
  const results = []
  for (const fontCase of FONT_CASES) {
    for (const width of WIDTHS) {
      results.push(...runCase(corpus, fontCase, width))
    }
  }
  return results
}
