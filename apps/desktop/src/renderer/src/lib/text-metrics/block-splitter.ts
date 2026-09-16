// Splits markdown source into pretext-measurable text blocks and opaque
// blocks (fenced code). Deliberately lightweight — it only needs to be good
// enough to beat a constant height guess; measureElement stays the authority
// and absorbs any misclassification (hybrid architecture, spec §3).

export type MarkdownBlock = { kind: 'text'; text: string } | { kind: 'opaque'; text: string }

const FENCE_RE = /^(```|~~~)/

export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let buffer: string[] = []
  // Opening fence marker (``` or ~~~) while inside a fenced region.
  let fence: string | null = null

  const flushParagraphs = () => {
    if (buffer.length === 0) return
    for (const para of buffer.join('\n').split(/\n{2,}/)) {
      // white-space: normal collapses single newlines to spaces, same as the DOM.
      const text = para.replace(/\n/g, ' ').trim()
      if (text) blocks.push({ kind: 'text', text })
    }
    buffer = []
  }

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (fence) {
      buffer.push(line)
      if (trimmed.startsWith(fence)) {
        blocks.push({ kind: 'opaque', text: buffer.join('\n') })
        buffer = []
        fence = null
      }
      continue
    }
    if (FENCE_RE.test(trimmed)) {
      flushParagraphs()
      fence = trimmed.slice(0, 3)
      buffer.push(line)
      continue
    }
    buffer.push(line)
  }

  // Unclosed fence (streaming tail mid-fence): the remainder is opaque —
  // its height is roughly lines × line-height either way.
  if (fence) {
    blocks.push({ kind: 'opaque', text: buffer.join('\n') })
  } else {
    flushParagraphs()
  }
  return blocks
}
