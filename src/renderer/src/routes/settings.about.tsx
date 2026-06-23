import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/about')({ component: About })

function About(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-2">
      <h2 className="font-medium text-lg">SwarmAgents</h2>
      <p className="text-muted-foreground text-sm">Bundle: dev.swarmagents.app · Auto-update via electron-updater.</p>
    </div>
  )
}
