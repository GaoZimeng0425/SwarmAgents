import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: General })

function General(): React.JSX.Element {
  return (
    <div className="max-w-xl space-y-4">
      <h2 className="font-medium text-lg">General</h2>
      <p className="text-muted-foreground text-sm">Settings will appear here as features are added.</p>
    </div>
  )
}
