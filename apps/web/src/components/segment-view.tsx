import type { Segment } from '@swarm/shared'

// Render one Segment (the flattened conversational unit from buildSegments).
// Plain text only for MVP — markdown rendering is a follow-up.
export function SegmentView({ segment }: { segment: Segment }): React.JSX.Element {
  switch (segment.kind) {
    case 'user':
      return (
        <div className="flex justify-end px-4 py-1">
          <div className="max-w-[85%] rounded-2xl bg-primary px-3 py-2 text-primary-foreground text-sm">
            {segment.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="px-4 py-1">
          <div className="max-w-[90%] whitespace-pre-wrap text-foreground text-sm">{segment.text}</div>
        </div>
      )
    case 'reasoning':
      return (
        <div className="mx-4 my-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="text-muted-foreground text-xs italic">{segment.text}</p>
        </div>
      )
    case 'tool':
      return (
        <div className="mx-4 my-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="font-medium text-foreground text-sm">
            🔧 {segment.tool}
            {segment.ok === null ? ' ⋯' : segment.ok ? ' ✓' : ' ✗'}
          </p>
          {segment.output && (
            <pre className="mt-1 max-h-40 overflow-auto text-muted-foreground text-xs">{segment.output}</pre>
          )}
        </div>
      )
    case 'error':
      return (
        <div className="mx-4 my-1 rounded-lg bg-destructive/10 px-3 py-2">
          <p className="text-destructive text-sm">
            {segment.label === 'stopped' ? '⏹' : '⚠'} {segment.detail}
          </p>
        </div>
      )
    case 'event':
      return (
        <div className="px-4 py-0.5">
          <p className="text-muted-foreground text-xs">
            {segment.label}: {segment.detail}
          </p>
        </div>
      )
  }
}
