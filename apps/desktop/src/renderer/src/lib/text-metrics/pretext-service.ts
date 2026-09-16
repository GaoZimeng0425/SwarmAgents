// Synchronous text-height prediction built on @chenglou/pretext.
//
// prepare() is the expensive pass (segmentation + canvas measurement) and is
// cached in an LRU keyed by text; its result is width-independent, so resize
// only re-runs layout() — pure arithmetic. Estimates only need to beat the
// constant guess; measureElement stays the authority (hybrid, spec §3).
//
// `prepare`/`layout` backends are injectable so unit tests can run without a
// Canvas 2D context.
import { type PreparedText, layout as pretextLayout, prepare as pretextPrepare } from '@chenglou/pretext'

import {
  estimateMarkdownHeight as composeMarkdownHeight,
  estimateByCharCount,
  FALLBACK_LINE_HEIGHT,
  MAX_MEASURABLE_CHARS,
} from './height-model'

const LRU_MAX_ENTRIES = 2000

export type PrepareBackend = (
  text: string,
  font: string,
  options: { whiteSpace: 'normal' | 'pre-wrap'; wordBreak: 'normal' | 'keep-all' }
) => PreparedText
export type LayoutBackend = (
  prepared: PreparedText,
  maxWidth: number,
  lineHeight: number
) => { height: number; lineCount: number }
export type FontProbe = () => { family: string; weight: string; size: number }

export type TextMetricsService = {
  /** Predicted height of one markdown document at `width`, in px. */
  estimateMarkdownHeight: (markdown: string, width: number) => number
  /** Cache size — exposed for debug logging. */
  size: () => number
}

class Lru<V> {
  private map = new Map<string, V>()
  constructor(private max: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      // Refresh recency.
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
  clear(): void {
    this.map.clear()
  }
  get size(): number {
    return this.map.size
  }
}

export function createTextMetricsService({
  probeFont,
  prepare = pretextPrepare,
  layout = pretextLayout,
  lineHeight = FALLBACK_LINE_HEIGHT,
}: {
  probeFont: FontProbe
  prepare?: PrepareBackend
  layout?: LayoutBackend
  lineHeight?: number
}): TextMetricsService {
  const cache = new Lru<PreparedText>(LRU_MAX_ENTRIES)
  const probed = probeFont()
  const fontKey = `${probed.weight} ${probed.size}px ${probed.family}`

  const preparedFor = (text: string): PreparedText | null => {
    if (text.length > MAX_MEASURABLE_CHARS) return null
    let handle = cache.get(text)
    if (handle === undefined) {
      handle = prepare(text, fontKey, { whiteSpace: 'normal', wordBreak: 'normal' })
      cache.set(text, handle)
    }
    return handle
  }

  const paragraphHeight = (text: string, width: number): number => {
    const handle = preparedFor(text)
    if (!handle) return estimateByCharCount(text, width, lineHeight)
    const { lineCount } = layout(handle, width, lineHeight)
    // The browser renders at least one line even for empty/whitespace text.
    return Math.max(1, lineCount) * lineHeight
  }

  return {
    estimateMarkdownHeight: (markdown, width) => composeMarkdownHeight(markdown, width, paragraphHeight),
    size: () => cache.size,
  }
}

let service: TextMetricsService | null | undefined

/** Shared singleton; null when there is no DOM to probe (tests, SSR). */
export function getTextMetricsService(): TextMetricsService | null {
  if (service !== undefined) return service
  if (typeof document === 'undefined') {
    service = null
    return service
  }
  service = createTextMetricsService({
    probeFont: () => {
      const el = document.querySelector<HTMLElement>('.user-content') ?? document.body
      const cs = getComputedStyle(el)
      return { family: cs.fontFamily, weight: cs.fontWeight, size: Number.parseFloat(cs.fontSize) }
    },
  })
  // Webfonts can land after first paint; early estimates used fallback metrics
  // and the cache must not outlive them.
  document.fonts?.ready.then(() => {
    service = undefined
  })
  return service
}
