import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({ component: About })

function About(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-2">
      <h2 className="text-lg font-medium">SwarmAgents</h2>
      <p className="text-sm text-muted-foreground">
        Bundle: dev.swarmagents.app · Auto-update via electron-updater.
      </p>
    </div>
  )
}
