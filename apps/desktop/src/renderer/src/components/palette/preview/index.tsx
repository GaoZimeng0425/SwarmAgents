// apps/desktop/src/renderer/src/components/palette/preview/index.tsx
// Right-pane switch: renders the matching per-kind preview component for the
// selected item's PreviewData, or a neutral hint when nothing is selected.
// The dispatch preview additionally needs the formation list + the lifted
// pickedFormation state, threaded in from palette-dialog.tsx.
import type { PreviewData } from '../../../lib/palette/types'
import { ChatPreview } from './chat'
import { DispatchPreview, type FormationOption } from './dispatch'
import { InfoPreview } from './info'
import { TaskRunPreview } from './task-run'
import { TaskSchedPreview } from './task-sched'

export type PreviewSwitchProps = {
  preview: PreviewData | null
  formations: FormationOption[]
  picked: string
  onPick: (id: string) => void
}

export function PreviewSwitch(props: PreviewSwitchProps): React.JSX.Element {
  const { preview, formations, picked, onPick } = props
  if (!preview) {
    return <div className="p-4 text-muted-foreground text-xs">选择左侧条目查看详情</div>
  }
  switch (preview.type) {
    case 'info':
      return <InfoPreview data={preview} />
    case 'dispatch':
      return <DispatchPreview data={preview} formations={formations} onPick={onPick} picked={picked} />
    case 'chat':
      return <ChatPreview data={preview} />
    case 'taskRun':
      return <TaskRunPreview data={preview} />
    case 'taskSched':
      return <TaskSchedPreview data={preview} />
  }
}
