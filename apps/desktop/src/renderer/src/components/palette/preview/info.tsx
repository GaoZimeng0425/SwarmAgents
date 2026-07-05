// apps/desktop/src/renderer/src/components/palette/preview/info.tsx
// Generic right-pane preview. Covers the command / agent / file / service /
// memory / skill kinds, which all share the same title + optional desc +
// key/value rows shape.
import type { PreviewData } from '../../../lib/palette/types'

export type InfoPreviewData = Extract<PreviewData, { type: 'info' }>

export function InfoPreview({ data }: { data: InfoPreviewData }): React.JSX.Element {
  return (
    <div className="p-4">
      <h4 className="font-semibold text-sm">{data.title}</h4>
      {data.desc && <p className="mt-1 text-muted-foreground text-xs">{data.desc}</p>}
      {data.rows.length > 0 && (
        <dl className="mt-3 space-y-1.5 text-xs">
          {data.rows.map((r) => (
            <div className="flex justify-between gap-3" key={r.label}>
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="truncate text-right font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
