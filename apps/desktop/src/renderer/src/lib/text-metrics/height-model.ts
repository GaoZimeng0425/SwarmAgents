// Composes markdown height estimates out of per-block measurements.
// Pure functions — the measurement backend is injected so tests can run
// without a Canvas 2D context (jsdom has none).

import { splitMarkdownBlocks } from './block-splitter'

export const FALLBACK_LINE_HEIGHT = 20
export const FALLBACK_CHAR_WIDTH = 7.2 // ≈ 14px system font, CJK/latin blend
// Beyond this, prepare()'s O(n) cost outweighs estimate quality; degrade to a
// character-count estimate (spec §5 超长文本降级).
export const MAX_MEASURABLE_CHARS = 20000

/** Returns the predicted height in px for a single text run at `width`. */
export type MeasureText = (text: string, width: number) => number

export function estimateOpaqueHeight(text: string, lineHeight = FALLBACK_LINE_HEIGHT): number {
  const lines = Math.max(1, text.split('\n').length)
  return lines * lineHeight + 16 // code-block padding/border chrome
}

/** Character-count fallback for over-long runs: glyphs per line at a blended
 * average width, then lines × line-height. */
export function estimateByCharCount(text: string, width: number, lineHeight = FALLBACK_LINE_HEIGHT): number {
  const charsPerLine = Math.max(1, Math.floor(width / FALLBACK_CHAR_WIDTH))
  const chars = [...text].length || 1
  return Math.ceil(chars / charsPerLine) * lineHeight
}

export function estimateMarkdownHeight(markdown: string, width: number, measureText: MeasureText): number {
  let total = 0
  for (const block of splitMarkdownBlocks(markdown)) {
    if (block.kind === 'opaque') {
      total += estimateOpaqueHeight(block.text)
    } else if (block.text.length > MAX_MEASURABLE_CHARS) {
      total += estimateByCharCount(block.text, width)
    } else {
      total += measureText(block.text, width)
    }
  }
  return total
}
