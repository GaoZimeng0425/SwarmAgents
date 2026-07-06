import { createFileRoute } from '@tanstack/react-router'

// Temporary placeholder until Task 5 swaps in <FormationsView/>.
export const Route = createFileRoute('/formations')({
  component: (): React.JSX.Element => <div className="p-8">formations placeholder</div>,
})
