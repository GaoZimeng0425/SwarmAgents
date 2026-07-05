// apps/desktop/src/renderer/src/components/palette/preview/dispatch.tsx
// Hero dispatch preview. Shows the goal term, the formation picker (a native
// <select> bound to lifted `pickedFormation` state), and the 预计步骤 outline.
// The picker's onChange calls back into usePaletteState.setPickedFormation, and
// the rebuilt `cb` (whose useMemo deps include pickedFormation) captures the
// new value so the dispatch item's run() submits with the chosen formation.
import type { PreviewData } from '../../../lib/palette/types'

export type DispatchPreviewData = Extract<PreviewData, { type: 'dispatch' }>
export type FormationOption = { id: string; label: string }

export type DispatchPreviewProps = {
  data: DispatchPreviewData
  formations: FormationOption[]
  /** Currently picked formation id (lifted in usePaletteState). */
  picked: string
  /** Setter wired to usePaletteState.setPickedFormation. */
  onPick: (id: string) => void
}

export function DispatchPreview({ data, formations, picked, onPick }: DispatchPreviewProps): React.JSX.Element {
  return (
    <div className="p-4">
      <div className="text-muted-foreground text-xs">指派给 Agent</div>
      <h4 className="mt-1 font-semibold text-base leading-snug">「{data.term}」</h4>
      <label className="mt-3 block text-muted-foreground text-xs">
        编队
        <select
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
          onChange={(e) => onPick(e.target.value)}
          value={picked}
        >
          {formations.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-3 text-muted-foreground text-xs">预计步骤</div>
      <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs">
        <li>规划:拆解目标,选择 Agent</li>
        <li>检索:收集所需上下文</li>
        <li>综合:产出结果并汇报</li>
      </ol>
    </div>
  )
}
