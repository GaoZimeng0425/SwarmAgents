// Temporary shim: Task 6 removes this file (and its last importer,
// settings-dialog.tsx). Until then, delegate to FormationsView so the
// legacy "Agents" settings tab keeps working without the deleted OrgTreeView.
import { FormationsView } from './formations-view'

export function AgentsView(): React.JSX.Element {
  return <FormationsView />
}
