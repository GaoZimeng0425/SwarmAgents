import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/permissions')({ component: Permissions })

function Permissions(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-4">
      <h2 className="font-medium text-lg">Permissions</h2>
      <p className="text-muted-foreground text-sm">
        Default policy: prompt on medium and high. Per-tool overrides coming in a later release.
      </p>
    </div>
  )
}
