import type { Segment } from '@swarm/shared'

// render_ui tool segments are interactive cards shown inline; collapsing one
// behind a group header would hide it, so they never join a tool group.
export function isGroupableTool(seg: Segment): boolean {
  return seg.kind === 'tool' && seg.tool !== 'render_ui'
}

export type RenderItem = { kind: 'single'; seg: Segment } | { kind: 'tools'; segs: Segment[] }

// Collapse consecutive groupable tool segments into one render item so a turn
// that fires several tools shows as a single collapsible row instead of a stack
// of identical cards. A lone tool stays a single item (renders as before); only
// runs of 2+ become a group. Pure; unit-tested.
export function groupSegments(segs: Segment[]): RenderItem[] {
  const items: RenderItem[] = []
  let run: Segment[] = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) items.push({ kind: 'single', seg: run[0] })
    else items.push({ kind: 'tools', segs: run })
    run = []
  }
  for (const seg of segs) {
    if (isGroupableTool(seg)) {
      run.push(seg)
    } else {
      flush()
      items.push({ kind: 'single', seg })
    }
  }
  flush()
  return items
}
