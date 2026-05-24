import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: General })

function General(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-lg font-medium">General</h2>
      <p className="text-sm text-muted-foreground">
        Settings will appear here as features are added.
      </p>
    </div>
  )
}
