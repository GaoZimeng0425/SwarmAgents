import { SettingsHeader } from './settings-primitives'

export function AboutView(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <SettingsHeader
        description="Bundle: dev.swarmagents.app · Auto-update via electron-updater."
        title="SwarmAgents"
      />
    </div>
  )
}
