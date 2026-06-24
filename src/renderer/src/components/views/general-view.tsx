import { SettingsHeader } from './settings-primitives'

export function GeneralView(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <SettingsHeader description="Settings will appear here as features are added." title="General" />
    </div>
  )
}
