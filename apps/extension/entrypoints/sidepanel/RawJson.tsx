// Shared collapsible raw-JSON debug region. Used at the bottom of the
// bookmarks and tabs views to show the UNMODIFIED chrome.* API return value
// (not a projection). Native <details> gives expand/collapse semantics for
// free; <pre> preserves JSON indentation. Payloads are small (bookmarks tree,
// tabs snapshot) so eager serialization is fine.
import type { JSX } from 'react'

export function RawJson({ data, label }: { data: unknown; label: string }): JSX.Element {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-muted-foreground text-xs">{label}</summary>
      <pre className="mt-1 overflow-x-auto rounded bg-muted/30 p-2 text-[10px] leading-tight">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  )
}
