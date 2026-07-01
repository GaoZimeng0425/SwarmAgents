import { basename, FILE_PATH_RE } from './file-paths'

// We carry the path on the link URL behind a private scheme so a custom <a>
// renderer can intercept it (and a urlTransform can whitelist it).
export const FILE_LINK_SCHEME = 'swarmfile:'

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] }

function splitText(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  for (const m of value.matchAll(FILE_PATH_RE)) {
    const start = m.index ?? 0
    const full = m[0]
    if (start > last) out.push({ type: 'text', value: value.slice(last, start) })
    out.push({ type: 'link', url: FILE_LINK_SCHEME + full, children: [{ type: 'text', value: basename(full) }] })
    last = start + full.length
  }
  if (out.length === 0) return [{ type: 'text', value }]
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function walk(node: MdNode): void {
  if (!node.children) return
  const next: MdNode[] = []
  for (const child of node.children) {
    if (child.type === 'text') {
      next.push(...splitText(child.value ?? ''))
    } else {
      // Don't rewrite paths already inside links or code spans/blocks.
      if (child.type !== 'link' && child.type !== 'code' && child.type !== 'inlineCode') walk(child)
      next.push(child)
    }
  }
  node.children = next
}

/** remark plugin: rewrite bare file-path text into clickable links (basename label). */
export function remarkFilePaths() {
  return (tree: MdNode): void => walk(tree)
}
